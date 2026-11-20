// V-13e grading: an independent judge model grades the plain QA checks in <data>/plain-checks.jsonl against the gap code.
// Per check: accuracy (accurate / minor_issue / wrong), testable, duplicate of the report, and per claimed gap whether the
// check exercises it (a merged check that does not really test a gap would hide it: a recall risk).
// Per gap marked untestable: whether a tester could in fact observe its effect (also a recall risk).
// Usage: node --import tsx tools/impactbench-plain-checks-grade.mts --evidence <work>/evidence [--data impactbench/eval/data-v4]
import * as fs from 'node:fs';
import OpenAI from 'openai';
import { config } from 'dotenv';
import analyzer from '../packages/analyzer/src/index';
import { renderChange, renderReport } from '../packages/reporting/src/verifier/questions';

config({ path: process.env.GRAPHENTRA_ENV ?? '.env', quiet: true });
const flag = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const EVIDENCE = flag('evidence')!;
const DATA = flag('data', 'impactbench/eval/data-v4')!;
const JUDGE = flag('judge', 'deepseek/deepseek-v4-pro-0813')!;
const PRICE: Record<string, [number, number]> = { 'deepseek/deepseek-v4-pro-0813': [0.111, 4.44] };
const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 2, timeout: 240_000 });

const CHECK_JUDGE = `You grade one QA check that was written from code changes. You get the QA REPORT it was added to, the CHECK, and the GAPS it claims to test (each with BEFORE = old code and AFTER = new code).
Return JSON: {"accuracy": "accurate" | "minor_issue" | "wrong", "testable": boolean, "duplicate": boolean, "gaps": [{"key": string, "addressed": boolean}], "note": string}
- accuracy: "accurate" if every concrete claim in the check (behaviour, conditions, values, expected result) is supported by the code changes. "minor_issue" if it is mostly supported but one detail is not shown by the code or is vague. "wrong" if it describes behaviour the code does not have, invents settings or values, or swaps old and new behaviour.
- testable: true if a manual tester or a caller of the library can carry it out and observe a result.
- duplicate: true if the QA REPORT already has essentially the same check.
- gaps: one entry per gap key given. addressed = true if carrying out the check would exercise the behaviour that changed in that gap.
- note: one short sentence on the main problem, or "" if none.`;

const UNTESTABLE_JUDGE = `A QA tool decided that this code change has no effect a manual tester or a caller of the library could observe (for example only types or internal wiring), so it wrote no QA check for it. You get the change (BEFORE = old code, AFTER = new code).
Return JSON: {"observable": boolean, "note": string}
- observable: true if the change does alter behaviour a tester or caller could observe (output, UI, returned values, errors, exports a caller imports at runtime). false if it only changes types, comments, formatting, internal structure with identical behaviour, or code that is not reachable.
- note: one short sentence explaining why.`;

const usage = { prompt: 0, completion: 0 };
async function judge(system: string, user: string): Promise<any> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await client.chat.completions.create({ model: JUDGE, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
      usage.prompt += res.usage?.prompt_tokens ?? 0; usage.completion += res.usage?.completion_tokens ?? 0;
      return JSON.parse(res.choices[0]?.message.content ?? '');
    } catch (error) { if (attempt >= 3) return { error: String(error) }; }
  }
}

const runs = fs.readFileSync(`${DATA}/runs.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.valid && r.variant === 'verify');
const plain = fs.readFileSync(`${DATA}/plain-checks.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const impactsById = new Map<string, Map<string, any>>();
const impactsFor = (id: string) => {
  if (!impactsById.has(id)) impactsById.set(id, new Map(analyzer.readEvidence(JSON.parse(fs.readFileSync(`${EVIDENCE}/${id}.json`, 'utf8'))).impacts.map((i: any) => [i.changedEntity.id, i])));
  return impactsById.get(id)!;
};
const gapText = (impacts: Map<string, any>, entity: string, key: string) => (impacts.get(entity) ? renderChange(impacts.get(entity), `GAP ${key}:`, 2500) : `GAP ${key}: ${entity} (no code)`);

const jobs: Array<() => Promise<any>> = [];
for (const p of plain) {
  const report = runs.find(r => r.id === p.id && r.run === p.run).report;
  const impacts = impactsFor(p.id);
  p.checks.forEach((check: any, index: number) => jobs.push(async () => {
    const keys = check.entities.map((_: string, i: number) => `G${i + 1}`);
    const user = `${renderReport(report)}\n\nCHECK: ${check.text}\n\nGAPS\n\n${check.entities.map((e: string, i: number) => gapText(impacts, e, keys[i])).join('\n\n')}`;
    const verdict = await judge(CHECK_JUDGE, user);
    const addressed = new Map((verdict.gaps ?? []).map((g: any) => [g.key, g.addressed]));
    return { kind: 'check', id: p.id, run: p.run, index, text: check.text, entities: check.entities, ...verdict,
      gaps: check.entities.map((entity: string, i: number) => ({ entity, addressed: addressed.get(keys[i]) ?? null })) };
  }));
  for (const entity of p.untestable) jobs.push(async () => ({ kind: 'untestable', id: p.id, run: p.run, entity, ...(await judge(UNTESTABLE_JUDGE, gapText(impacts, entity, 'G1'))) }));
}

const out: any[] = [];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (next < jobs.length) { const job = jobs[next++]; out.push(await job()); if (out.length % 20 === 0) process.stderr.write(`${out.length}/${jobs.length}\n`); } }));
out.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.run - b.run || (a.index ?? 0) - (b.index ?? 0) || String(a.entity).localeCompare(String(b.entity)));
fs.writeFileSync(`${DATA}/plain-checks-grades.jsonl`, `${out.map(o => JSON.stringify(o)).join('\n')}\n`);

const checks = out.filter(o => o.kind === 'check' && !o.error);
const pairs = checks.flatMap(c => c.gaps);
const untestable = out.filter(o => o.kind === 'untestable' && !o.error);
const count = (xs: any[], f: (x: any) => boolean) => xs.filter(f).length;
const [pin, pout] = PRICE[JUDGE] ?? [0, 0];
const summary = {
  judge: JUDGE, errors: count(out, o => o.error),
  checks: checks.length, accurate: count(checks, c => c.accuracy === 'accurate'), minorIssue: count(checks, c => c.accuracy === 'minor_issue'), wrong: count(checks, c => c.accuracy === 'wrong'),
  testable: count(checks, c => c.testable), duplicate: count(checks, c => c.duplicate),
  gapPairs: pairs.length, gapsAddressed: count(pairs, g => g.addressed === true), gapsNotAddressed: count(pairs, g => g.addressed === false), gapsUnknown: count(pairs, g => g.addressed == null),
  untestable: untestable.length, untestableButObservable: count(untestable, u => u.observable),
  costUSD: (usage.prompt * pin + usage.completion * pout) / 1e6, tokens: usage,
};
fs.writeFileSync(`${DATA}/plain-checks-grades-summary.json`, `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
