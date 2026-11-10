#!/usr/bin/env node
// Corpus-32 evaluation: analyzer recall, QA report catch/explain rates, and the lookup tool. Plan: impactbench/eval/PLAN.md.
//
//   node --import tsx tools/impactbench-report-eval.mts evidence --history <dir> --work <dir> [ids...]
//   node --import tsx tools/impactbench-report-eval.mts run --history <dir> --work <dir> [--variants base,lookup,lookup-always] [--runs 3] [--concurrency 6] [ids...]
//   node --import tsx tools/impactbench-report-eval.mts summary
//
// <history> holds one full-history clone per corpus repo. <work> receives checkouts and evidence (large; keep it outside the repo).
// Rows append to impactbench/eval/data/runs.jsonl; a rerun skips (id, variant, run) rows already there.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import OpenAI from 'openai';
import analyzer from '../packages/analyzer/src/index';
import reporting, { type LookupLogEntry } from '../packages/reporting/src/index';

const { readEvidence } = analyzer;
const { buildLLMPayload, buildSurfaceEvidence, generateQAReport, loadApplicationContext } = reporting;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ARG = process.argv.indexOf('--data');
// --data <dir> keeps a run's rows, summary and CSV apart from the default data set.
const DATA = DATA_ARG > 0 ? path.resolve(process.argv[DATA_ARG + 1]) : path.join(ROOT, 'impactbench/eval/data');
const RUNS = path.join(DATA, 'runs.jsonl');

// fixtures/large-repos is git-ignored, so a worktree has none: fall back to the main checkout (parent of the shared .git dir).
const MAIN_CHECKOUT = path.dirname(execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const EXCALIDRAW_CONTEXT = process.env.EXCALIDRAW_CONTEXT ?? [ROOT, MAIN_CHECKOUT].map(dir => path.join(dir, 'fixtures/large-repos/excalidraw/.graphentra/application-context.json')).find(file => fs.existsSync(file))!;

const MAIN_ENV = process.env.GRAPHENTRA_ENV ?? [ROOT, MAIN_CHECKOUT].map(dir => path.join(dir, '.env')).find(file => fs.existsSync(file)) ?? path.join(ROOT, '.env');
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
const ids = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const history = flag('history') ? path.resolve(flag('history')!) : undefined;
const work = flag('work') ? path.resolve(flag('work')!) : undefined;
config({ path: MAIN_ENV, quiet: true });
const REPORT_MODEL = flag('model', process.env.OPENROUTER_MODEL ?? 'openai/gpt-6-luna')!;
const JUDGE_MODEL = flag('judge', 'deepseek/deepseek-v4-pro-0813')!;
// USD per million tokens, from the OpenRouter models API on 2026-11-09; used only when the provider reports no cost.
const PRICE: Record<string, [number, number]> = { 'openai/gpt-6-luna': [0.1, 0.5], 'deepseek/deepseek-v4-pro-0813': [0.111, 4.44], 'deepseek/deepseek-v4.1-flash-1017': [0.006, 0.5] };

type Truth = { id: string; outsideIntroducerDiff: boolean; role: string };
type Entry = { id: string; repo: string; changeClass: string; symptom: string; evidence: string; introducer: { sha: string; subject: string }; fix: { subject: string }; affected: { entities: Truth[]; areas: string[] } };
const corpus: Entry[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'impactbench/corpus/d0-corpus.json'), 'utf8'));
const selected = corpus.filter(entry => !ids.length || ids.includes(entry.id));
const evidenceFile = (id: string) => path.join(work!, 'evidence', `${id}.json`);

function need(value: string | undefined, name: string): string { if (!value) throw new Error(`--${name} is required`); return value; }

// ---------- evidence ----------
function makeEvidence(entry: Entry) {
  const checkout = path.join(work!, 'checkouts', entry.id);
  if (!fs.existsSync(checkout)) execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', path.join(history!, entry.repo), checkout]);
  execFileSync('git', ['-C', checkout, 'checkout', '-qf', entry.introducer.sha]);
  execFileSync('git', ['-C', checkout, 'clean', '-qfdx']);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'packages/analyzer/src/cli.ts', '--target', checkout, '--base', `${entry.introducer.sha}~1`,
    '--head', entry.introducer.sha, '--engine', 'extended', '--output', evidenceFile(entry.id)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (result.status !== 0) return { id: entry.id, ok: false, seconds, error: (result.stderr || result.stdout).split('\n').filter(Boolean).slice(-3).join(' ') };
  return { id: entry.id, ok: true, seconds };
}

// ---------- context ----------
let excalidrawContext: any;
function contextFor(entry: Entry, graph: any) {
  if (entry.repo === 'excalidraw') {
    excalidrawContext ??= JSON.parse(fs.readFileSync(EXCALIDRAW_CONTEXT, 'utf8'));
    // The context was generated on today's layout (packages/*); older commits keep code under src/. Map summaries by path tail.
    const summaries = excalidrawContext.fileSummaries ?? [];
    const exact = new Map(summaries.map((s: any) => [s.file, s]));
    const byTail = new Map<string, any>();
    for (const s of summaries) byTail.set(s.file.replace(/^packages\/(excalidraw|common|element|math|utils)\//, '').replace(/^src\//, ''), s);
    const fileSummaries = graph.analyzedFiles.map((file: string) => {
      const tail = file.replace(/^packages\/(excalidraw|common|element|math|utils)\//, '').replace(/^src\//, '');
      const hit: any = exact.get(file) ?? byTail.get(tail) ?? byTail.get(tail.replace(/^element\//, ''));
      return hit ? { ...hit, file } : undefined;
    }).filter(Boolean);
    return { ...excalidrawContext, fileSummaries };
  }
  return {
    schemaVersion: '2.0',
    meta: { generatedAt: '2026-11-09T00:00:00.000Z', generator: { model: 'none', promptVersion: 'none' }, sourceHeadSha: entry.introducer.sha, analyzerVersion: '',
      coverage: { eligibleEntities: 0, annotatedEntities: 0, surfaces: 0, describedSurfaces: 0 } },
    unassignedFiles: [],
    application: { name: entry.repo, summary: 'No application context has been generated for this repository.', purpose: '', platform: 'unknown', userRoles: [] },
    features: [], surfaces: [], fileSummaries: [], glossary: [], entityAnnotations: [], rules: [], openQuestions: [], unknowns: ['No application context was generated.'],
  };
}
// meta.unassignedFiles lives under meta in the schema.
function fixContext(ctx: any) { if ('unassignedFiles' in ctx && !('unassignedFiles' in ctx.meta)) { ctx.meta.unassignedFiles = ctx.unassignedFiles; delete ctx.unassignedFiles; } return ctx; }

// ---------- metered client ----------
function meteredClient(model: string) {
  const meter = { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0, last: undefined as string | undefined };
  const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 2, timeout: 240_000 });
  const create = client.chat.completions.create.bind(client.chat.completions);
  (client.chat.completions as any).create = (body: any, opts: any) => {
    const promise: any = create({ ...body, max_tokens: body.max_tokens ?? 8000, usage: { include: true } }, opts);
    promise.then((completion: any) => {
      if (body.response_format?.type === 'json_schema') meter.last = completion?.choices?.[0]?.message?.content ?? meter.last;
      const usage = completion?.usage; if (!usage) return;
      meter.calls += 1; meter.prompt += usage.prompt_tokens ?? 0; meter.completion += usage.completion_tokens ?? 0;
      meter.cached += usage.prompt_tokens_details?.cached_tokens ?? 0;
      const [pin, pout] = PRICE[model] ?? [0, 0];
      meter.cost += typeof usage.cost === 'number' ? usage.cost : ((usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout) / 1e6;
    }, () => {});
    return promise;
  };
  return { client, meter };
}

// ---------- judge ----------
const JUDGE = `You grade a QA report against ONE known regression that shipped in a real commit. You get the regression (what users saw,
the user-visible areas, and how the later fix proved it) and the report's numbered checks and text fields.
For EACH check decide "exposes": if a tester did exactly this check, with the input it states, on the build that has the regression,
would the check fail because of this regression? It must exercise the broken behaviour AND use the triggering condition (for example a
value of 0 when only 0 breaks, a dotfile name when only dotfiles break, spreadsheet cells when only tab-separated paste breaks).
A generic check ("verify X still works") with no triggering input does not count. A check of a different behaviour does not count.
Then decide for the whole report:
 "explained": some field says the change could break this behaviour, in words that name the mechanism or the triggering case.
 "area": the report points the tester at one of the user-visible areas (or the same capability in other words).
Return JSON {"checks":[{"n":1,"exposes":false}],"explained":false,"area":false,"why":"one sentence"}. Judge strictly from the words.`;

async function judge(entry: Entry, report: any, judgeClient: OpenAI) {
  const checks: string[] = (report.testAreas ?? []).flatMap((area: any) => area.checks);
  const input = {
    regression: { repo: entry.repo, commit: entry.introducer.subject, symptom: entry.symptom, areas: entry.affected.areas, howTheFixProvedIt: entry.evidence, fix: entry.fix.subject },
    report: { summary: report.summary, keyChanges: report.keyChanges, uncertainty: report.uncertainty, areas: (report.testAreas ?? []).map((a: any) => a.area), checks: checks.map((check, i) => ({ n: i + 1, check })) },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await judgeClient.chat.completions.create({ model: JUDGE_MODEL, temperature: 0, messages: [{ role: 'system', content: JUDGE }, { role: 'user', content: JSON.stringify(input) }], response_format: { type: 'json_object' } });
      const out = JSON.parse(res.choices[0]!.message.content ?? '{}');
      if (!Array.isArray(out.checks) || typeof out.explained !== 'boolean') throw new Error('bad judge output');
      const hits = out.checks.filter((c: any) => c.exposes).map((c: any) => checks[c.n - 1]).filter(Boolean);
      return { catch: hits.length > 0, explained: out.explained, area: Boolean(out.area), hits, why: String(out.why ?? '') };
    } catch (error) { if (attempt === 2) return { judgeError: (error as Error).message.slice(0, 200) }; }
  }
  return { judgeError: 'unreachable' };
}

// ---------- one report ----------
function classify(message: string) {
  if (/technical entity identifiers|source file names/.test(message)) return 'identifier-leak';
  if (/semantically invalid/.test(message)) return 'semantic-other';
  if (/not valid JSON|invalid structured|Expected|Invalid input|ZodError|too_big|too_small/.test(message)) return 'schema';
  if (/empty impact report|no content/.test(message)) return 'empty';
  if (/timed out|timeout|ETIMEDOUT|terminated|fetch failed/i.test(message)) return 'transport';
  return 'other';
}

const evidenceCache = new Map<string, any>();
function loadEvidence(id: string) {
  if (!evidenceCache.has(id)) evidenceCache.set(id, JSON.parse(fs.readFileSync(evidenceFile(id), 'utf8')));
  return evidenceCache.get(id);
}

/** Deterministic, per commit: where each truth entity appears in evidence and whether it survives into the payload. */
function analyzerFacts(entry: Entry) {
  const raw = loadEvidence(entry.id);
  const evidence = readEvidence(raw);
  const changed = new Set(evidence.impacts.map((i: any) => i.changedEntity.id));
  const blast = new Set(evidence.impacts.flatMap((i: any) => i.blastRadius.entities.map((e: any) => e.id)));
  const receivers = new Set(evidence.impacts.flatMap((i: any) => (i.receivesChangedValue ?? []).map((t: any) => t.entity.id)));
  const graphIds = new Set(evidence.technicalGraph.entities.map((e: any) => e.id));
  const { context, warnings } = loadApplicationContext(fixContext(contextFor(entry, evidence.technicalGraph)), evidence.technicalGraph);
  const payload = buildLLMPayload(evidence.impacts, context, { relations: evidence.technicalGraph.relations, contextWarnings: warnings,
    capabilities: evidence.technicalGraph.capabilities, surfaceEvidence: buildSurfaceEvidence(evidence) });
  const payloadText = JSON.stringify(payload);
  const truth = entry.affected.entities.map(t => ({
    id: t.id, outside: t.outsideIntroducerDiff, role: t.role, inGraph: graphIds.has(t.id),
    as: changed.has(t.id) ? 'changed' : blast.has(t.id) ? 'blast' : receivers.has(t.id) ? 'receiver' : 'missed',
    inPayload: payloadText.includes(`"${t.id}"`),
  }));
  return {
    outcome: raw.outcome ?? evidence.outcome, impacts: evidence.impacts.length, blastTotal: blast.size, receivers: receivers.size,
    payloadBytes: Buffer.byteLength(payloadText), truth,
    contextFiles: (context.fileSummaries ?? []).length, hasContext: entry.repo === 'excalidraw',
  };
}

async function oneReport(entry: Entry, variant: string, run: number) {
  const started = Date.now();
  const raw = loadEvidence(entry.id);
  const graph = readEvidence(raw).technicalGraph;
  const context = fixContext(contextFor(entry, graph));
  const { client, meter } = meteredClient(REPORT_MODEL);
  const { client: judgeClient, meter: judgeMeter } = meteredClient(JUDGE_MODEL);
  const read = (file: string) => { try { return execFileSync('git', ['-C', path.join(history!, entry.repo), 'show', `${entry.introducer.sha}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; } };
  const lookup = variant === 'base' ? undefined : { read, style: variant === 'lookup-always' ? 'always' as const : 'optional' as const };
  let row: any = { id: entry.id, repo: entry.repo, changeClass: entry.changeClass, variant, run, model: REPORT_MODEL };
  const logs: LookupLogEntry[] = [];
  const quiet = console.info; console.info = () => {};
  try {
    const result = await generateQAReport(raw, context, { client, model: REPORT_MODEL, logLevel: 'off' }, lookup ? { lookup } : {});
    console.info = quiet;
    logs.push(...(result.lookups ?? []));
    const grade = await judge(entry, result.qaReport, judgeClient);
    row = { ...row, valid: true, ...grade, report: result.qaReport };
  } catch (error) {
    console.info = quiet;
    const message = (error as Error).message ?? String(error);
    row = { ...row, valid: false, failure: classify(message), error: message.slice(0, 400) };
    // Grade the last rejected draft too: it separates "would it have caught the bug" from "did validation pass".
    try {
      const draft = JSON.parse(meter.last ?? '');
      if (draft?.testAreas) { const grade: any = await judge(entry, draft, judgeClient); row.draft = { catch: grade.catch, explained: grade.explained, area: grade.area, hits: grade.hits }; row.report = draft; }
    } catch { /* no usable draft */ }
  }
  const truthIds = new Set(entry.affected.entities.map(t => t.id));
  const outsideIds = new Set(entry.affected.entities.filter(t => t.outsideIntroducerDiff).map(t => t.id));
  const looked = new Set(logs.flatMap(l => l.entityIds));
  row.lookups = { count: logs.length, hits: logs.filter(l => l.hit).length, truth: [...looked].filter(id => truthIds.has(id)).length,
    outside: [...looked].filter(id => outsideIds.has(id)).length, log: logs.map(({ mode, query, hit, entityIds, refused }) => ({ mode, query, hit, n: entityIds.length, ...(refused ? { refused } : {}) })) };
  const strip = ({ last, ...rest }: any) => rest;
  row.usage = { report: strip(meter), judge: strip(judgeMeter) };
  row.seconds = Math.round((Date.now() - started) / 1000);
  row.payloadBytes = payloadKb(entry.id) * 1024;
  return row;
}

// ---------- commands ----------
const payloadKb = (id: string) => { const facts = JSON.parse(fs.readFileSync(path.join(DATA, 'analyzer.json'), 'utf8')); return (facts.find((f: any) => f.id === id)?.payloadBytes ?? 0) / 1024; };
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await work(items[next++]!); }));
}

if (command === 'evidence') {
  need(flag('history'), 'history'); need(flag('work'), 'work');
  fs.mkdirSync(path.join(work!, 'evidence'), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  const results: any[] = [];
  await pool(selected.filter(e => !fs.existsSync(evidenceFile(e.id)) || rest.includes('--force')), Number(flag('concurrency', '3')), async entry => {
    const r = makeEvidence(entry); results.push(r); console.log(`${entry.id} ${r.ok ? 'ok' : 'FAILED'} ${r.seconds}s${r.ok ? '' : ` ${r.error}`}`);
  });
  const facts = selected.filter(e => fs.existsSync(evidenceFile(e.id))).map(entry => ({ id: entry.id, repo: entry.repo, changeClass: entry.changeClass,
    seconds: results.find(r => r.id === entry.id)?.seconds, ...analyzerFacts(entry) }));
  const previous = fs.existsSync(path.join(DATA, 'analyzer.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'analyzer.json'), 'utf8')) : [];
  const merged = [...previous.filter((p: any) => !facts.some(f => f.id === p.id)).map((p: any) => p), ...facts.map(f => ({ ...f, seconds: f.seconds ?? previous.find((p: any) => p.id === f.id)?.seconds }))]
    .sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(DATA, 'analyzer.json'), `${JSON.stringify(merged, null, 1)}\n`);
  const all = merged.flatMap((f: any) => f.truth);
  const rate = (list: any[], test: (t: any) => boolean) => `${list.filter(test).length}/${list.length}`;
  console.log(`truth in evidence ${rate(all, t => t.as !== 'missed')}, outside diff ${rate(all.filter((t: any) => t.outside), t => t.as !== 'missed')}, in payload ${rate(all, t => t.inPayload)}`);
} else if (command === 'run') {
  need(flag('history'), 'history'); need(flag('work'), 'work');
  if (!process.env.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found (looked in ${MAIN_ENV}).`);
  fs.mkdirSync(DATA, { recursive: true });
  const done = new Set(fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean).map(line => { const r = JSON.parse(line); return `${r.id}|${r.variant}|${r.run}`; }) : []);
  const variants = flag('variants', 'base,lookup,lookup-always')!.split(',');
  const runs = Number(flag('runs', '3'));
  const jobs = selected.flatMap(entry => variants.flatMap(variant => Array.from({ length: runs }, (_, i) => ({ entry, variant, run: i + 1 }))))
    .filter(job => !done.has(`${job.entry.id}|${job.variant}|${job.run}`) && fs.existsSync(evidenceFile(job.entry.id)))
    // --lookup-max-kb: skip tool variants on payloads above this size (each lookup round resends the payload).
    .filter(job => job.variant === 'base' || !flag('lookup-max-kb') || payloadKb(job.entry.id) <= Number(flag('lookup-max-kb')))
    // --skip-started: leave commits that already have rows alone (budget runs cover only untouched commits).
    .filter(job => !rest.includes('--skip-started') || ![...done].some(key => key.startsWith(`${job.entry.id}|`)));
  console.log(`${jobs.length} reports to run with ${REPORT_MODEL}, judged by ${JUDGE_MODEL}`);
  let finished = 0; let spent = 0;
  await pool(jobs, Number(flag('concurrency', '6')), async ({ entry, variant, run }) => {
    let row: any;
    try { row = await oneReport(entry, variant, run); }
    catch (error) { console.log(`HARNESS ERROR ${entry.id} ${variant}#${run}: ${(error as Error).message}`); return; }
    fs.appendFileSync(RUNS, `${JSON.stringify(row)}\n`);
    finished += 1; spent += row.usage.report.cost + row.usage.judge.cost;
    console.log(`[${finished}/${jobs.length}] ${entry.id} ${variant}#${run} ${row.valid ? `catch=${row.catch} explained=${row.explained}` : `INVALID ${row.failure}`} lookups=${row.lookups.count} ${row.seconds}s $${spent.toFixed(2)}`);
  });
} else if (command === 'summary') {
  const rows = fs.readFileSync(RUNS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const facts: any[] = JSON.parse(fs.readFileSync(path.join(DATA, 'analyzer.json'), 'utf8'));
  const variants = [...new Set(rows.map(r => r.variant))];
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const byVariant: any = {};
  for (const v of variants) {
    const rs = rows.filter(r => r.variant === v);
    const commits = [...new Set(rs.map(r => r.id))];
    const majority = (test: (r: any) => boolean) => commits.filter(id => { const c = rs.filter(r => r.id === id); return c.filter(test).length * 2 > c.length; }).length;
    const groups = (test: (r: any) => boolean) => ({ app: rs.filter(r => r.repo === 'excalidraw' && test(r)).length, lib: rs.filter(r => r.repo !== 'excalidraw' && test(r)).length });
    byVariant[v] = {
      reports: rs.length, valid: rs.filter(r => r.valid).length, catch: rs.filter(r => r.catch).length, explained: rs.filter(r => r.explained).length, area: rs.filter(r => r.area).length,
      commitsMajorityCatch: majority(r => r.catch), commitsMajorityExplained: majority(r => r.explained), commitsAnyCatch: commits.filter(id => rs.some(r => r.id === id && r.catch)).length, commits: commits.length,
      catchBy: groups(r => r.catch), reportsBy: groups(() => true),
      failures: rs.filter(r => !r.valid).reduce((acc: any, r) => ({ ...acc, [r.failure]: (acc[r.failure] ?? 0) + 1 }), {}),
      judgeErrors: rs.filter(r => r.judgeError).length,
      lookups: { mean: rs.reduce((s, r) => s + r.lookups.count, 0) / (rs.length || 1), reportsUsing: rs.filter(r => r.lookups.count > 0).length, truthTouched: rs.filter(r => r.lookups.truth > 0).length, outsideTouched: rs.filter(r => r.lookups.outside > 0).length },
      cost: rs.reduce((s, r) => s + r.usage.report.cost, 0), judgeCost: rs.reduce((s, r) => s + r.usage.judge.cost, 0), meanSeconds: rs.reduce((s, r) => s + r.seconds, 0) / (rs.length || 1),
    };
    const b = byVariant[v];
    console.log(`${v.padEnd(14)} valid ${pct(b.valid, b.reports)} catch ${pct(b.catch, b.reports)} explained ${pct(b.explained, b.reports)} | commits(majority) catch ${b.commitsMajorityCatch}/${b.commits} | lookups ${b.lookups.mean.toFixed(1)} | $${b.cost.toFixed(2)}`);
  }
  const perCommit = facts.map(f => ({ id: f.id, repo: f.repo, changeClass: f.changeClass, hasContext: f.hasContext, payloadBytes: f.payloadBytes, impacts: f.impacts,
    truth: f.truth.map((t: any) => `${t.as}${t.inPayload ? '' : '(not in payload)'}${t.outside ? '*' : ''}`),
    ...Object.fromEntries(variants.map(v => { const rs = rows.filter(r => r.id === f.id && r.variant === v);
      return [v, { runs: rs.length, valid: rs.filter(r => r.valid).length, catch: rs.filter(r => r.catch).length, explained: rs.filter(r => r.explained).length, lookups: rs.reduce((s, r) => s + r.lookups.count, 0) }]; })) }));
  // Time and cost per report against payload size: one CSV row per report, and a table by size bucket.
  const sizeOf = (r: any) => r.payloadBytes ?? facts.find(f => f.id === r.id)?.payloadBytes ?? 0;
  const costOf = (r: any) => r.usage.report.cost + r.usage.judge.cost;
  const csv = ['id,variant,run,payloadKB,seconds,reportCostUSD,judgeCostUSD,totalCostUSD,promptTokens,cachedTokens,completionTokens,llmCalls,lookups,valid,catch,explained',
    ...rows.map(r => [r.id, r.variant, r.run, Math.round(sizeOf(r) / 1024), r.seconds, r.usage.report.cost.toFixed(5), r.usage.judge.cost.toFixed(5), costOf(r).toFixed(5),
      r.usage.report.prompt, r.usage.report.cached, r.usage.report.completion, r.usage.report.calls, r.lookups.count, r.valid, Boolean(r.catch || r.draft?.catch), Boolean(r.explained)].join(','))];
  fs.writeFileSync(path.join(DATA, 'cost-time.csv'), `${csv.join('\n')}\n`);
  const buckets: [number, number][] = [[0, 50], [50, 250], [250, 500], [500, 1024], [1024, 2048], [2048, Infinity]];
  const costTime = variants.flatMap(v => buckets.map(([lo, hi]) => {
    const rs = rows.filter(r => r.variant === v && sizeOf(r) / 1024 >= lo && sizeOf(r) / 1024 < hi);
    const sorted = rs.map(r => r.seconds).sort((a, b) => a - b);
    return { variant: v, payloadKB: `${lo}-${hi === Infinity ? '' : hi}`, reports: rs.length, meanSeconds: rs.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / rs.length) : 0,
      medianSeconds: sorted[Math.floor(sorted.length / 2)] ?? 0, meanCost: rs.length ? rs.reduce((a, r) => a + costOf(r), 0) / rs.length : 0, totalCost: rs.reduce((a, r) => a + costOf(r), 0) };
  }).filter(b => b.reports));
  console.log('\nvariant        payloadKB   reports  mean s  median s  mean $   total $');
  for (const b of costTime) console.log(`${b.variant.padEnd(14)} ${b.payloadKB.padEnd(11)} ${String(b.reports).padStart(7)} ${String(b.meanSeconds).padStart(7)} ${String(b.medianSeconds).padStart(9)}  ${b.meanCost.toFixed(4)}  ${b.totalCost.toFixed(3)}`);
  console.log(`total ${rows.length} reports, $${rows.reduce((a, r) => a + costOf(r), 0).toFixed(2)}, ${(rows.reduce((a, r) => a + r.seconds, 0) / 3600).toFixed(1)} report-hours; per-report CSV: ${path.relative(ROOT, path.join(DATA, 'cost-time.csv'))}`);
  fs.writeFileSync(path.join(DATA, 'summary.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), reportModel: rows[0]?.model, judgeModel: JUDGE_MODEL, byVariant, costTime, perCommit }, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, path.join(DATA, 'summary.json'))}`);
} else {
  console.log('Usage: evidence | run | summary. See the header of this file.');
}
