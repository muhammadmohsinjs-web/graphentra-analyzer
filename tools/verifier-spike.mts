#!/usr/bin/env node
// Phase V · V-2: run the labelled verifier set (impactbench/verifier/labels.jsonl) through each candidate and score it.
//
//   NODE_USE_ENV_PROXY=1 node --import tsx tools/verifier-spike.mts run --provider openai|google|judge|fake [--concurrency 4] [--limit N] [--force]
//   node --import tsx tools/verifier-spike.mts score [--reviewed-only]
//
// `run` appends one row per item to impactbench/verifier/results/<provider>.jsonl and skips items already there (unless --force).
// `score` writes impactbench/verifier/SPIKE.md: recall/precision of "not covered" per threshold, Brier score, reliability, cost, latency,
// and the V-3 gate (recall >= 0.90 and precision >= 0.60). Recall-first (ADR-0011): a refusal, error or missing answer is a flag.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';
import { brier, flagged, GATE, gatePick, prf, reliability, THRESHOLDS, type Scored } from './verifier-spike-scoring.ts';

export { brier, flagged, GATE, gatePick, prf, reliability, THRESHOLDS, type Scored };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'impactbench/verifier');
const LABELS = path.join(DIR, 'labels.jsonl');
const RESULTS = path.join(DIR, 'results');
const MAIN_CHECKOUT = path.dirname(execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
config({ path: process.env.GRAPHENTRA_ENV ?? [ROOT, MAIN_CHECKOUT].map(d => path.join(d, '.env')).find(f => fs.existsSync(f)), quiet: true });

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };

const TIMEOUT_MS = 60_000;
// USD per million tokens [input, cached input, output]. Decisions pricing is not published on the reference page; the OpenAI and
// Google rows are ESTIMATES from the gpt-6-luna chat price and must be replaced from the invoice. The judge reports its own cost.
const PRICE: Record<string, [number, number, number]> = { openai: [0.1, 0.01, 0.5], google: [0.1, 0.01, 0.5], judge: [0.111, 0.111, 4.44], fake: [0, 0, 0] };
const JUDGE_MODEL = flag('judge-model', 'deepseek/deepseek-v4-pro-0813')!;

type Kind = 'coverage' | 'trigger' | 'faithfulness';
type Item = { id: string; kind: Kind; commit: string; question: string; input: string; label: boolean; reviewed: boolean };
export type Result = { id: string; inputHash: string; provider: string; model: string; outcome: 'answer' | 'refusal' | 'error'; p: number | null; error?: string; ms: number;
  usage: { input: number; cached: number; output: number }; cost: number; costEstimated: boolean; at: string };
type Answer = Pick<Result, 'outcome' | 'p' | 'error' | 'model'> & { usage: Result['usage']; cost?: number };

/** Answers are reused only while the item's question and input are unchanged. */
const inputHash = (item: Item) => createHash('sha256').update(`${item.question}\n${item.input}`).digest('hex').slice(0, 16);
const readJsonl = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : []);

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  return JSON.parse(text);
}

// ---------- providers ----------
const providers: Record<string, (item: Item) => Promise<Answer>> = {
  // POST /v1/decisions: input + up to 400 questions; predicate answers carry `probability` (of true), or type "refusal".
  async openai(item) {
    const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('OPENAI_API_KEY is not set');
    const out = await post('https://api.openai.com/v1/decisions', { authorization: `Bearer ${key}` },
      { model: 'gpt-6-luna', input: item.input, questions: [{ type: 'predicate', name: 'verdict', instructions: item.question }], prompt_cache_key: `graphentra-v2-${item.commit}` });
    const answer = out.answers?.[0];
    const usage = { input: out.usage?.input_tokens ?? 0, cached: out.usage?.input_tokens_details?.cached_tokens ?? 0, output: out.usage?.output_tokens ?? 0 };
    if (answer?.type === 'predicate' && typeof answer.probability === 'number') return { outcome: 'answer', p: answer.probability, model: out.model, usage };
    return { outcome: answer?.type === 'refusal' ? 'refusal' : 'error', p: null, error: answer ? undefined : 'missing answer', model: out.model, usage };
  },
  // POST /v1beta/decisions (beta): questions keyed by id; the true/false type is "noul" with { noul, confidence }.
  async google(item) {
    const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY is not set');
    const out = await post('https://generativelanguage.googleapis.com/v1beta/decisions', { 'x-goog-api-key': key },
      { model: 'gemini-decision-1', input: item.input, questions: { verdict: { type: 'noul', instructions: item.question } } });
    const answer = out.answers?.verdict;
    const usage = { input: out.usage?.total_input_tokens ?? 0, cached: out.usage?.total_cached_tokens ?? 0, output: (out.usage?.total_output_tokens ?? 0) + (out.usage?.total_thought_tokens ?? 0) };
    if (answer?.type === 'noul' && typeof answer.noul === 'boolean' && typeof answer.confidence === 'number')
      return { outcome: 'answer', p: answer.noul ? answer.confidence : 1 - answer.confidence, model: 'gemini-decision-1', usage };
    const blocked = out.prompt_feedback?.block_reason;
    return { outcome: answer?.type === 'refusal' || blocked ? 'refusal' : 'error', p: null, error: blocked ?? (answer ? undefined : 'missing answer'), model: 'gemini-decision-1', usage };
  },
  // The current generative ImpactBench judge (OpenRouter), asked the same question with a stated confidence.
  async judge(item) {
    const key = process.env.OPENROUTER_API_KEY; if (!key) throw new Error('OPENROUTER_API_KEY is not set');
    const system = `${item.question}\nReturn only JSON {"answer": true or false, "confidence": number from 0.5 to 1 for how sure you are of that answer}.`;
    const out = await post('https://openrouter.ai/api/v1/chat/completions', { authorization: `Bearer ${key}` },
      { model: JUDGE_MODEL, temperature: 0, max_tokens: 4000, response_format: { type: 'json_object' }, usage: { include: true }, messages: [{ role: 'system', content: system }, { role: 'user', content: item.input }] });
    const usage = { input: out.usage?.prompt_tokens ?? 0, cached: out.usage?.prompt_tokens_details?.cached_tokens ?? 0, output: out.usage?.completion_tokens ?? 0 };
    try {
      const parsed = JSON.parse(out.choices?.[0]?.message?.content ?? '');
      if (typeof parsed.answer !== 'boolean') throw new Error('no boolean answer');
      const c = Math.min(1, Math.max(0.5, Number(parsed.confidence) || 0.5));
      return { outcome: 'answer', p: parsed.answer ? c : 1 - c, model: out.model ?? JUDGE_MODEL, usage, cost: out.usage?.cost };
    } catch (error) { return { outcome: 'error', p: null, error: `unparsable: ${(error as Error).message}`, model: out.model ?? JUDGE_MODEL, usage, cost: out.usage?.cost }; }
  },
  // Offline: a noisy oracle, so the pipeline and the metrics can be tested without network.
  async fake(item) {
    const u = parseInt(createHash('sha256').update(item.id).digest('hex').slice(0, 8), 16) / 0xffffffff;
    if (u < 0.03) return { outcome: 'refusal', p: null, model: 'fake', usage: { input: 0, cached: 0, output: 0 } };
    const p = item.label ? 0.35 + 0.65 * u : 0.75 * u;
    return { outcome: 'answer', p, model: 'fake', usage: { input: Math.round(item.input.length / 4), cached: 0, output: 1 } };
  },
};

async function ask(provider: string, item: Item): Promise<Result> {
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const a = await providers[provider](item);
      const [pin, pcached, pout] = PRICE[provider];
      const estimated = ((a.usage.input - a.usage.cached) * pin + a.usage.cached * pcached + a.usage.output * pout) / 1e6;
      return { id: item.id, inputHash: inputHash(item), provider, model: a.model, outcome: a.outcome, p: a.p, ...(a.error ? { error: a.error } : {}), ms: Date.now() - started, usage: a.usage,
        cost: typeof a.cost === 'number' ? a.cost : estimated, costEstimated: typeof a.cost !== 'number', at: new Date().toISOString() };
    } catch (error) {
      const status = (error as any).status as number | undefined;
      const retry = attempt < 3 && (!status || status === 429 || status >= 500);
      if (!retry) return { id: item.id, inputHash: inputHash(item), provider, model: '', outcome: 'error', p: null, error: (error as Error).message.slice(0, 300), ms: Date.now() - started, usage: { input: 0, cached: 0, output: 0 }, cost: 0, costEstimated: true, at: new Date().toISOString() };
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function run() {
  const provider = flag('provider'); if (!provider || !providers[provider]) throw new Error(`--provider must be one of ${Object.keys(providers).join(', ')}`);
  const file = path.join(RESULTS, `${provider}.jsonl`);
  const items = readJsonl<Item>(LABELS);
  const force = rest.includes('--force');
  const done = new Set(force ? [] : readJsonl<Result>(file).filter(r => r.outcome !== 'error').map(r => `${r.id}|${r.inputHash}`));
  const todo = items.filter(i => !done.has(`${i.id}|${inputHash(i)}`)).slice(0, Number(flag('limit', String(items.length))));
  fs.mkdirSync(RESULTS, { recursive: true });
  if (force && fs.existsSync(file)) fs.rmSync(file);
  // Errors are retried on the next run: drop their old rows.
  else if (fs.existsSync(file)) fs.writeFileSync(file, readJsonl<Result>(file).filter(r => r.outcome !== 'error').map(r => `${JSON.stringify(r)}\n`).join(''));
  console.log(`${provider}: ${todo.length} items to ask (${done.size} already done)`);
  let next = 0; let spent = 0; let finished = 0;
  await Promise.all(Array.from({ length: Number(flag('concurrency', '4')) }, async () => {
    while (next < todo.length) {
      const item = todo[next++];
      const result = await ask(provider, item);
      fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
      spent += result.cost; finished += 1;
      if (result.outcome !== 'answer' || finished % 10 === 0) console.log(`${finished}/${todo.length} $${spent.toFixed(4)} ${result.id} ${result.outcome}${result.error ? ` ${result.error.slice(0, 120)}` : ''}`);
    }
  }));
  console.log(`done: ${finished} asked, $${spent.toFixed(4)}`);
}

// ---------- scoring ----------
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function score() {
  const reviewedOnly = rest.includes('--reviewed-only');
  const items = readJsonl<Item>(LABELS).filter(i => !reviewedOnly || i.reviewed);
  const byId = new Map(items.map(i => [i.id, i]));
  const files = fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS).filter(f => f.endsWith('.jsonl')).sort() : [];
  const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)} %` : '–');
  const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const reviewed = items.filter(i => i.reviewed).length;
  const out: string[] = [
    '# Phase V · V-2 spike results', '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`tools/verifier-spike.mts score${reviewedOnly ? ' --reviewed-only' : ''}\`. Items: ${items.length} (${reviewed} reviewed).`,
    'Positive class = **flag** ("not covered" / "not supported", label false). Recall-first: refusal, error or missing answer counts as a flag.',
    `Gate (V-3, ADR-0011): recall ≥ ${GATE.recall} and precision ≥ ${GATE.precision} at one threshold.`, '',
  ];
  if (reviewed < items.length) out.push(`> [!warning] ${items.length - reviewed} labels are still drafts. The gate is only valid with \`--reviewed-only\` after review.`, '');
  const summary: string[] = ['| Provider | Items | Answered | Refusals | Errors | Brier | Gate pick | Cost (USD) | p50 / p95 latency |', '|---|---|---|---|---|---|---|---|---|'];
  const detail: string[] = [];
  for (const file of files) {
    const provider = file.replace(/\.jsonl$/, '');
    const results = readJsonl<Result>(path.join(RESULTS, file)).filter(r => byId.has(r.id) && r.inputHash === inputHash(byId.get(r.id)!));
    const latest = new Map(results.map(r => [r.id, r]));
    const scored = [...latest.values()].map(r => ({ r, item: byId.get(r.id)!, s: { label: byId.get(r.id)!.label, p: r.p } }));
    const all = scored.map(x => x.s);
    const pick = gatePick(all);
    const cost = [...latest.values()].reduce((a, r) => a + r.cost, 0);
    const estimated = [...latest.values()].some(r => r.costEstimated && r.cost > 0);
    const ms = [...latest.values()].filter(r => r.outcome !== 'error').map(r => r.ms);
    summary.push(`| ${provider} | ${latest.size}/${items.length} | ${scored.filter(x => x.r.outcome === 'answer').length} | ${scored.filter(x => x.r.outcome === 'refusal').length} | ${scored.filter(x => x.r.outcome === 'error').length} | ${num(brier(all))} | ${pick ? `**PASS** t=${pick.t} (R ${pct(pick.recall)}, P ${pct(pick.precision)})` : '**FAIL**'} | ${cost.toFixed(4)}${estimated ? ' (est.)' : ''} | ${Math.round(quantile(ms, 0.5))} / ${Math.round(quantile(ms, 0.95))} ms |`);
    detail.push(`## ${provider}`, '', '| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |', '|---|---|---|---|---|---|---|');
    for (const t of THRESHOLDS) {
      const a = prf(all, t);
      const k = (kind: Kind) => { const r = prf(scored.filter(x => x.item.kind === kind).map(x => x.s), t); return `${pct(r.recall)} / ${pct(r.precision)}`; };
      detail.push(`| ${t} | ${pct(a.recall)} | ${pct(a.precision)} | ${a.flags} | ${k('coverage')} | ${k('trigger')} | ${k('faithfulness')} |`);
    }
    detail.push('', 'Reliability (P(true) bins):', '', '| Bin | n | mean P | fraction true |', '|---|---|---|---|');
    for (const b of reliability(all)) detail.push(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${num(b.meanP, 2)} | ${num(b.fracTrue, 2)} |`);
    const misses = scored.filter(x => !x.s.label && !flagged(x.s, pick?.t ?? 0.5)).map(x => `\`${x.r.id}\` (p=${num(x.s.p ?? NaN, 2)})`);
    detail.push('', `Missed "not covered" items at t=${pick?.t ?? 0.5}: ${misses.length ? misses.join(', ') : 'none'}`, '');
  }
  out.push('## Summary', '', ...summary, '', ...detail);
  fs.writeFileSync(path.join(DIR, 'SPIKE.md'), `${out.join('\n')}\n`);
  console.log(summary.join('\n'));
}

if (command === 'run') run().catch(error => { console.error(error); process.exitCode = 1; });
else if (command === 'score') score();
else if (command) throw new Error(`unknown command ${command}`);
