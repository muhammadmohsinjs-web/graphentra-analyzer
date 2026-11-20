// V-13e offline replay: plain checks for the saved data-v4 verify reports (no new report, no verifier call).
import * as fs from 'node:fs';
import OpenAI from 'openai';
import { config } from 'dotenv';
// Usage: node --import tsx tools/impactbench-plain-checks.mts --evidence <work>/evidence [--data impactbench/eval/data-v4]
import analyzer from '../packages/analyzer/src/index';
import { writePlainChecks } from '../packages/reporting/src/verifier/plain-checks';
config({ path: process.env.GRAPHENTRA_ENV ?? '.env', quiet: true });
const flag = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const EVIDENCE = flag('evidence')!;
const DATA = flag('data', 'impactbench/eval/data-v4')!;
const MODEL = 'openai/gpt-6-luna';
const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 2, timeout: 240_000 });
console.info = () => {};
const rows = fs.readFileSync(`${DATA}/runs.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(r => r.valid && r.variant === 'verify' && r.report?.notCovered?.length);
const out: any[] = [];
let next = 0;
async function worker() {
  while (next < rows.length) {
    const r = rows[next++];
    const impacts = analyzer.readEvidence(JSON.parse(fs.readFileSync(`${EVIDENCE}/${r.id}.json`, 'utf8'))).impacts;
    const res = await writePlainChecks(r.report, r.report.notCovered, impacts, { client, model: MODEL });
    out.push({ id: r.id, run: r.run, gaps: r.report.notCovered.length, ...res });
    process.stderr.write(`${r.id} r${r.run}: ${r.report.notCovered.length} gaps -> ${res.checks.length} checks, ${res.untestable.length} untestable, ${res.fallback.length} fallback, ${(res.durationMs/1000).toFixed(1)}s${res.error ? ' ERROR ' + res.error : ''}\n`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
out.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
fs.writeFileSync(`${DATA}/plain-checks.jsonl`, out.map(o => JSON.stringify(o)).join('\n') + '\n');
