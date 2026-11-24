#!/usr/bin/env node
// Corpus-32 evaluation: analyzer recall, QA report catch/explain rates, and the lookup tool. Plan: impactbench/eval/PLAN.md.
//
//   node --import tsx tools/impactbench-report-eval.mts evidence --history <dir> --work <dir> [ids...]
//   node --import tsx tools/impactbench-report-eval.mts run --history <dir> --work <dir> [--variants base,lookup,lookup-always,verify,cluster] [--cluster-concurrency 4] [--group-size 10] [--max-groups 8] [--runs 3] [--concurrency 6] [ids...]
//   (openai/* report models, e.g. openai/gpt-6-luna, call the OpenAI API directly with OPENAI_API_KEY; --provider openrouter forces the OpenRouter route. The judge and other models stay on OpenRouter.)
//   (verify = base plus the Phase V verifier; needs OPENAI_API_KEY for the Decisions API. Rows gain usage.verifier, usage.repair, verification, audit.)
//   node --import tsx tools/impactbench-report-eval.mts summary [--grades <hand-grades.jsonl> [--grades-model glm]]
//   (--grades: catch/explained from hand grades, matched on id and run, instead of the API judge. Summary also prints R-0 band tables.)
//   node --import tsx tools/impactbench-report-eval.mts sections --work <dir> [--json <file>] [ids...]
//   (R-0: bytes and estimated tokens per payload section, as sent and compact. No LLM calls.)
//   node --import tsx tools/impactbench-report-eval.mts cluster-plan --history <dir> --work <dir> [--threshold 15] [ids...]
//   (R-10, free: groups and request sizes for the cluster variant, through the real report path with a canned provider. No LLM calls.)
//
// Any command takes --corpus <file> (default impactbench/corpus/d0-corpus.json) and --data <dir>; the R-11 large-change set is
//   --corpus impactbench/corpus/r11-large.json --data impactbench/eval/data-r11
// <history> holds one full-history clone per corpus repo. <work> receives checkouts and evidence (large; keep it outside the repo).
// Rows append to impactbench/eval/data/runs.jsonl; a rerun skips (id, variant, run) rows already there.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import OpenAI from 'openai';
import analyzer from '../packages/analyzer/src/index';
import reporting, { type DecisionAnswer, type DecisionClient, type LookupLogEntry, type ReportVerification } from '../packages/reporting/src/index';
import { LARGE_VARIANTS, largePayloadReport, payloadSections, payloadSizes, type LargeVariant } from './impactbench-large-payload.mts';

const { readEvidence } = analyzer;
const { buildLLMPayload, buildSurfaceEvidence, createOpenAIDecisionClient, DEFAULT_THRESHOLD, generateQAReport, getSourceRole, judgeAnswer, loadApplicationContext, notCoveredDisplay } = reporting;

/** E7: lines QA reads for the gaps: the plain checks (V-13e) or, without them, the grouped code list (V-13d). The developer list under the checks is not counted (V-13f). */
const shownLines = (report: any) => { const d = notCoveredDisplay(report); return d.checks.length || d.developer.length; };
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
// gpt-6-luna (any openai/* model) goes straight to the OpenAI API with OPENAI_API_KEY; everything else stays on OpenRouter.
// --provider openrouter forces the old OpenRouter route for the report model.
const direct = (model: string) => model.startsWith('openai/') && flag('provider') !== 'openrouter';
const JUDGE_MODEL = flag('judge', 'deepseek/deepseek-v4-pro-0813')!;
// --no-judge: write reports only; catch/explain are graded by hand afterwards (no API judge).
const NO_JUDGE = rest.includes('--no-judge');
// --max-tokens: output cap per call (reasoning models can spend the default 8000 on hidden reasoning and return nothing).
const MAX_TOKENS = Number(flag('max-tokens', '8000'));
// --timeout-s: per-request writer timeout; 0 means no practical limit (24 h), for slow models.
const TIMEOUT_MS = Number(flag('timeout-s', '240')) * 1000 || 86_400_000;
// USD per million tokens, from the OpenRouter models API on 2026-11-09; used only when the provider reports no cost.
const PRICE: Record<string, [number, number]> = { 'openai/gpt-6-luna': [0.1, 0.5], 'deepseek/deepseek-v4-pro-0813': [0.111, 4.44], 'deepseek/deepseek-v4.1-flash-1017': [0.006, 0.5], 'z-ai/glm-5.3-flash': [0.0399, 0.0784] };

type Truth = { id: string; outsideIntroducerDiff: boolean; role: string };
type Entry = { id: string; repo: string; changeClass: string; symptom: string; evidence: string; introducer: { sha: string; subject: string }; fix: { subject: string }; affected: { entities: Truth[]; areas: string[] } };
// --corpus <file> selects another ground-truth set in the D-0 format, e.g. impactbench/corpus/r11-large.json (R-11). Pair it with --data.
const CORPUS = path.resolve(ROOT, flag('corpus', 'impactbench/corpus/d0-corpus.json')!);
const corpus: Entry[] = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
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
// The verifier's repair round (V-8, removed at V-13) was a writer call whose messages carried this opening line.
// Kept so the meter stays comparable with data-v3; usage.repair is now always zero.
const REPAIR_MARKER = 'A coverage check of your report found the gaps below.';
function meteredClient(model: string) {
  const meter = { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0, reasoning: 0, truncated: 0, last: undefined as string | undefined,
    // Subset of the above: calls sent after a repair round started (the repair call and any retry after it). M4.
    repair: { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0 } };
  const viaOpenAI = direct(model);
  const client = viaOpenAI
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL, maxRetries: 2, timeout: TIMEOUT_MS })
    : new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 2, timeout: TIMEOUT_MS });
  const create = client.chat.completions.create.bind(client.chat.completions);
  (client.chat.completions as any).create = (body: any, opts: any) => {
    // OpenRouter takes `usage.include`, `reasoning.effort` and `max_tokens`; the OpenAI API wants a bare model id,
    // `reasoning_effort` and `max_completion_tokens`, and rejects the OpenRouter extensions.
    let request: any;
    if (viaOpenAI) {
      const { reasoning, max_tokens, model: id, ...rest } = body;
      request = { ...rest, model: String(id).replace(/^openai\//, ''), max_completion_tokens: body.max_completion_tokens ?? max_tokens ?? MAX_TOKENS, ...(reasoning?.effort ? { reasoning_effort: reasoning.effort } : {}) };
    } else request = { ...body, max_tokens: body.max_tokens ?? MAX_TOKENS, usage: { include: true } };
    const promise: any = create(request, opts);
    promise.then((completion: any) => {
      if (body.response_format?.type === 'json_schema') meter.last = completion?.choices?.[0]?.message?.content ?? meter.last;
      const usage = completion?.usage; if (!usage) return;
      meter.reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
      if (completion?.choices?.[0]?.finish_reason === 'length') meter.truncated += 1;
      const [pin, pout] = PRICE[model] ?? [0, 0];
      const cost = typeof usage.cost === 'number' ? usage.cost : ((usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout) / 1e6;
      const repair = (body.messages ?? []).some((m: any) => typeof m.content === 'string' && m.content.startsWith(REPAIR_MARKER));
      for (const m of repair ? [meter, meter.repair] : [meter]) {
        m.calls += 1; m.prompt += usage.prompt_tokens ?? 0; m.completion += usage.completion_tokens ?? 0;
        m.cached += usage.prompt_tokens_details?.cached_tokens ?? 0; m.cost += cost;
      }
    }, () => {});
    return promise;
  };
  return { client, meter };
}

// ---------- verifier (Phase V, V-11) ----------
// USD per million tokens [input, cached input, output]. Decisions pricing is not published; same ESTIMATE as tools/verifier-spike.mts.
const DECISIONS_PRICE: [number, number, number] = [0.1, 0.01, 0.5];

/** Wraps the Decisions client: meters tokens, cost and wall time, and records every answer in arrival order (pass 1, then pass 2). */
function meteredDecisionClient(inner: DecisionClient) {
  const meter = { calls: 0, questions: 0, input: 0, cached: 0, output: 0, cost: 0, seconds: 0, refusals: 0, errors: 0, errorSamples: [] as string[] };
  const answers = new Map<string, DecisionAnswer[]>();
  let active = 0; let since = 0;
  const client: DecisionClient = {
    async decide(input, questions, options) {
      if (active++ === 0) since = Date.now();
      try {
        const result = await inner.decide(input, questions, options);
        meter.calls += 1; meter.questions += questions.length;
        meter.input += result.usage.inputTokens; meter.cached += result.usage.cachedTokens; meter.output += result.usage.outputTokens;
        const [pin, pcached, pout] = DECISIONS_PRICE;
        meter.cost += ((result.usage.inputTokens - result.usage.cachedTokens) * pin + result.usage.cachedTokens * pcached + result.usage.outputTokens * pout) / 1e6;
        for (const answer of result.answers) {
          if (answer.outcome === 'refusal') meter.refusals += 1;
          if (answer.outcome === 'error') {
            meter.errors += 1;
            // Errors count as "not covered" and can trigger a repair, so keep a few distinct messages to tell provider faults from real gaps.
            const sample = `${answer.id.split(':')[0]}: ${answer.message.slice(0, 200)}`;
            if (meter.errorSamples.length < 3 && !meter.errorSamples.includes(sample)) meter.errorSamples.push(sample);
          }
          answers.set(answer.id, [...(answers.get(answer.id) ?? []), answer]);
        }
        return result;
      } finally {
        // Wall time while at least one call is in flight (calls run in parallel inside a pass).
        if (--active === 0) meter.seconds += (Date.now() - since) / 1000;
      }
    },
  };
  return { client, meter, answers };
}

/**
 * M3 silent-drop audit. Every changed production entity must land in exactly one bucket: covered, fixed by the repair round
 * (data-v3 only), listed under "Not covered" (itself or through the parent it was folded into), or skipped as having no
 * behaviour change (V-13b). Anything else is a silent drop (E3 target: zero).
 */
function silentDropAudit(raw: unknown, report: any, verification: ReportVerification | undefined, answers: Map<string, DecisionAnswer[]>) {
  const production = readEvidence(raw).impacts.filter((i: any) => getSourceRole(i.changedEntity.file) === 'production').map((i: any) => i.changedEntity.id as string);
  const final = new Map((verification?.verification.entries ?? []).filter(e => e.kind === 'coverage' && e.entity).map(e => [e.entity!, e]));
  const listed = new Set((report?.notCovered ?? []).map((n: any) => n.entity));
  const buckets = { covered: [] as string[], fixedByRepair: [] as string[], notCovered: [] as string[], skipped: [] as string[], folded: [] as string[], silent: [] as string[] };
  let lostInRepair = 0;
  for (const id of production) {
    const last = final.get(id);
    // V-13b: skipped (no behaviour change) and folded inner functions are accounted for; a folded one is listed through its parent.
    if (last?.verdict === 'skipped') { buckets.skipped.push(id); continue; }
    const asked = last?.foldedInto ?? id;
    if (last?.foldedInto) buckets.folded.push(id);
    const first = judgeAnswer({ id: `coverage:${asked}`, kind: 'coverage', entity: asked } as any, answers.get(`coverage:${asked}`)?.[0], verification?.verification.threshold ?? DEFAULT_THRESHOLD);
    if (last?.verdict === 'covered') (first.verdict === 'covered' ? buckets.covered : buckets.fixedByRepair).push(id);
    else if (last && listed.has(asked)) { buckets.notCovered.push(id); if (first.verdict === 'covered') lostInRepair += 1; }
    else buckets.silent.push(id);
  }
  return {
    production: production.length, covered: buckets.covered.length, fixedByRepair: buckets.fixedByRepair.length, notCovered: buckets.notCovered.length,
    skipped: buckets.skipped.length, folded: buckets.folded.length,
    silentDrops: buckets.silent.length, silentDropIds: buckets.silent, lostInRepair,
    // A "Not covered" line for an entity that is not a changed production entity would mean the list is built from the wrong set.
    strayNotCovered: [...listed].filter(id => !production.includes(id as string)).length,
  };
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

async function judge(entry: Entry, report: any, judgeClient: OpenAI): Promise<any> {
  if (NO_JUDGE) return { judged: false };
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
  const lookup = variant === 'base' || variant === 'verify' || variant === 'cluster' ? undefined : { read, style: variant === 'lookup-always' ? 'always' as const : 'optional' as const };
  // verify = base + the Phase V verifier ("Not covered" list; no repair round since V-13). Same report model and judge as base.
  const decisions = variant === 'verify' ? meteredDecisionClient(createOpenAIDecisionClient({ apiKey: process.env.OPENAI_API_KEY })) : undefined;
  let verification: ReportVerification | undefined;
  let row: any = { id: entry.id, repo: entry.repo, changeClass: entry.changeClass, variant, run, model: REPORT_MODEL };
  const logs: LookupLogEntry[] = [];
  const quiet = console.info; console.info = () => {};
  try {
    if ((LARGE_VARIANTS as readonly string[]).includes(variant)) {
      const large = await largePayloadReport(variant as LargeVariant, raw, context, { client, model: REPORT_MODEL, logLevel: 'off' });
      console.info = quiet;
      const grade = await judge(entry, large.qaReport, judgeClient);
      row = { ...row, valid: true, ...grade, report: large.qaReport, large: large.notes,
        truthSent: entry.affected.entities.filter(t => large.sentText.includes(`"${t.id}"`)).map(t => t.id) };
      // Recall before the merge: would the analysts' own checks have caught it?
      if (large.findings?.length) { const g: any = await judge(entry, { summary: '', keyChanges: [], uncertainty: [], testAreas: [{ area: 'findings', checks: large.findings }] }, judgeClient); row.findingsCatch = g.catch; }
    } else {
    const result = await generateQAReport(raw, context, { client, model: REPORT_MODEL, logLevel: 'off' },
      lookup ? { lookup } : decisions ? { verify: { client: decisions.client } }
        // R-10: more than 15 changed functions are reviewed in groups; smaller changes take the base path.
        : variant === 'cluster' ? { cluster: {
          read, concurrency: Number(flag('cluster-concurrency', '4')),
          // The base revision supplies the code of changed functions that no longer exist at the analyzed one (removed or renamed away).
          readBase: (file: string) => { try { return execFileSync('git', ['-C', path.join(history!, entry.repo), 'show', `${entry.introducer.sha}^:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; } },
          ...(flag('group-size') ? { maxGroupSize: Number(flag('group-size')) } : {}), ...(flag('max-groups') ? { maxGroups: Number(flag('max-groups')) } : {}),
        } } : {});
    console.info = quiet;
    logs.push(...(result.lookups ?? []));
    verification = result.verification;
    const grade = await judge(entry, result.qaReport, judgeClient);
    row = { ...row, valid: true, ...grade, report: result.qaReport, ...(result.cluster ? { cluster: result.cluster } : {}) };
    }
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
  const strip = ({ last, repair, ...rest }: any) => rest;
  row.usage = { report: strip(meter), judge: strip(judgeMeter) };
  if (decisions) {
    // M4: repair calls stay inside usage.report (writer cost); usage.repair is that subset, usage.verifier is the Decisions cost.
    row.usage.repair = meter.repair;
    row.usage.verifier = { ...decisions.meter, seconds: Math.round(decisions.meter.seconds * 10) / 10 };
    if (verification) {
      const flagged = verification.verification.entries.filter(e => e.verdict === 'not_covered');
      // No repair round since V-13; data-v3 rows still carry passes/repairRequested/repairAccepted, and the summary reads them optionally.
      row.verification = { threshold: verification.verification.threshold, questions: verification.verification.entries.length,
        coverageGaps: flagged.filter(e => e.kind === 'coverage' && !e.foldedInto).length, faithfulnessFlags: flagged.filter(e => e.kind === 'faithfulness').length,
        skipped: verification.verification.entries.filter(e => e.verdict === 'skipped').length,
        folded: verification.verification.entries.filter(e => e.foldedInto).length,
        reasons: flagged.reduce((acc: any, e) => ({ ...acc, [e.reason]: (acc[e.reason] ?? 0) + 1 }), {}) };
    }
    // An invalid report has no final report to audit; E4 counts it, E3 does not.
    row.audit = row.valid ? silentDropAudit(raw, row.report, verification, decisions.answers) : { skipped: 'invalid' };
  }
  row.checks = (row.report?.testAreas ?? []).reduce((n: number, a: any) => n + (a.checks?.length ?? 0), 0);
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
  if (direct(REPORT_MODEL) && !process.env.OPENAI_API_KEY) throw new Error(`OPENAI_API_KEY not found (looked in ${MAIN_ENV}); ${REPORT_MODEL} runs directly on the OpenAI API.`);
  if ((!direct(REPORT_MODEL) || !NO_JUDGE) && !process.env.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found (looked in ${MAIN_ENV}).`);
  fs.mkdirSync(DATA, { recursive: true });
  const done = new Set(fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean).map(line => { const r = JSON.parse(line); return `${r.id}|${r.variant}|${r.run}`; }) : []);
  const variants = flag('variants', 'base,lookup,lookup-always')!.split(',');
  if (variants.includes('verify') && !process.env.OPENAI_API_KEY) throw new Error(`OPENAI_API_KEY not found (looked in ${MAIN_ENV}); the verify variant calls OpenAI Decisions directly.`);
  const runs = Number(flag('runs', '3'));
  const jobs = selected.flatMap(entry => variants.flatMap(variant => Array.from({ length: runs }, (_, i) => ({ entry, variant, run: i + 1 }))))
    .filter(job => !done.has(`${job.entry.id}|${job.variant}|${job.run}`) && fs.existsSync(evidenceFile(job.entry.id)))
    // --lookup-max-kb: skip tool variants on payloads above this size (each lookup round resends the payload).
    .filter(job => job.variant === 'base' || job.variant === 'verify' || job.variant === 'cluster' || !flag('lookup-max-kb') || payloadKb(job.entry.id) <= Number(flag('lookup-max-kb')))
    // --skip-started: leave commits that already have rows alone (budget runs cover only untouched commits).
    .filter(job => !rest.includes('--skip-started') || ![...done].some(key => key.startsWith(`${job.entry.id}|`)));
  console.log(`${jobs.length} reports to run with ${REPORT_MODEL}, ${NO_JUDGE ? 'not judged (--no-judge)' : `judged by ${JUDGE_MODEL}`}`);
  let finished = 0; let spent = 0;
  await pool(jobs, Number(flag('concurrency', '6')), async ({ entry, variant, run }) => {
    let row: any;
    try { row = await oneReport(entry, variant, run); }
    catch (error) { console.log(`HARNESS ERROR ${entry.id} ${variant}#${run}: ${(error as Error).message}`); return; }
    fs.appendFileSync(RUNS, `${JSON.stringify(row)}\n`);
    finished += 1; spent += row.usage.report.cost + row.usage.judge.cost + (row.usage.verifier?.cost ?? 0);
    const verified = row.audit ? ` repair=${row.verification?.repairRequested ?? '-'} notCovered=${row.audit.notCovered ?? '-'} silent=${row.audit.silentDrops ?? '-'}` : '';
    console.log(`[${finished}/${jobs.length}] ${entry.id} ${variant}#${run} ${row.valid ? `catch=${row.catch} explained=${row.explained}` : `INVALID ${row.failure}`} lookups=${row.lookups.count}${verified} ${row.seconds}s $${spent.toFixed(2)}`);
  });
} else if (command === 'sizes') {
  need(flag('work'), 'work');
  for (const entry of selected.filter(e => fs.existsSync(evidenceFile(e.id)))) {
    const raw = loadEvidence(entry.id); const ctx = fixContext(contextFor(entry, readEvidence(raw).technicalGraph));
    const s = payloadSizes(raw, ctx); const kb = (t: string) => Math.round(Buffer.byteLength(t) / 1024);
    const truth = (t: string) => `${entry.affected.entities.filter(e => t.includes(`"${e.id}"`)).length}/${entry.affected.entities.length}`;
    console.log(`${entry.id} original ${kb(s.original)} KB truth ${truth(s.original)} | compact ${kb(s.compact)} KB truth ${truth(s.compact)} | budget ${kb(s.budget)} KB truth ${truth(s.budget)} | chunks ${s.chunks.length} max ${Math.round(Math.max(...s.chunks) / 1024)} KB`);
  }
} else if (command === 'sections') {
  need(flag('work'), 'work');
  const kb = (b: number) => (b / 1024).toFixed(1);
  const all: any[] = [];
  for (const entry of selected.filter(e => fs.existsSync(evidenceFile(e.id)))) {
    const raw = loadEvidence(entry.id); const s = payloadSections(raw, fixContext(contextFor(entry, readEvidence(raw).technicalGraph)));
    all.push({ id: entry.id, ...s });
    const compactBy = new Map(s.compact.map(r => [r.section, r]));
    console.log(`\n${entry.id}  changed functions ${s.changedFunctions}  instruction ${kb(s.instructionBytes)} KB`);
    console.log(`${'section'.padEnd(40)} ${'sent KB'.padStart(9)} ${'tokens'.padStart(9)} ${'share'.padStart(6)} ${'compact KB'.padStart(11)} ${'tokens'.padStart(9)}`);
    const total = s.asSent.at(-1)!.bytes;
    const sections = [...new Set([...s.asSent.map(r => r.section), ...s.compact.map(r => r.section)])].filter(n => n !== 'TOTAL').concat('TOTAL');
    for (const name of sections) {
      const a = s.asSent.find(r => r.section === name); const c = compactBy.get(name);
      console.log(`${name.padEnd(40)} ${(a ? kb(a.bytes) : '-').padStart(9)} ${String(a?.tokens ?? '-').padStart(9)} ${(a ? `${Math.round((100 * a.bytes) / total)}%` : '-').padStart(6)} ${(c ? kb(c.bytes) : '-').padStart(11)} ${String(c?.tokens ?? '-').padStart(9)}`);
    }
  }
  if (flag('json')) { fs.writeFileSync(path.resolve(flag('json')!), `${JSON.stringify(all, null, 1)}\n`); console.log(`\nwrote ${flag('json')}`); }
} else if (command === 'cluster-plan') {
  // R-10, free: runs the real report path with a recording client that returns a canned report, so no model is called.
  // Shows, per commit, how the changed functions are grouped and how big each group's request is next to the one-call request.
  need(flag('work'), 'work'); need(flag('history'), 'history');
  const kb = (b: number) => (b / 1024).toFixed(1);
  const canned = { summary: 'The release changes behaviour.', keyChanges: ['A value changed.'], testAreas: [{ area: 'Area', surfaceIds: [], howToReach: 'Open the page.', access: 'Anyone.', setup: 'None.', checks: ['Verify the value.'] }], uncertainty: [] };
  const recorder = () => {
    const sent: number[] = [];
    const client: any = { chat: { completions: { create: (body: any) => {
      sent.push(body.messages.reduce((n: number, m: any) => n + Buffer.byteLength(String(m.content)), 0));
      const content = JSON.stringify(body.response_format.json_schema.name === 'qa_cluster_summary' ? { summary: canned.summary } : canned);
      const completion = { id: 'plan', model: 'plan', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
      const promise: any = Promise.resolve(completion); promise.withResponse = async () => ({ data: completion, request_id: 'plan' }); return promise;
    } } } };
    return { client, sent };
  };
  console.log('commit'.padEnd(16) + 'changed  groups  group sizes                    related KB (trunc)  one call KB  largest group KB  sum of groups KB');
  for (const entry of selected.filter(e => fs.existsSync(evidenceFile(e.id)))) {
    const raw = loadEvidence(entry.id); const context = fixContext(contextFor(entry, readEvidence(raw).technicalGraph));
    const readAt = (file: string) => { try { return execFileSync('git', ['-C', path.join(history!, entry.repo), 'show', `${entry.introducer.sha}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; } };
    const one = recorder(); const many = recorder();
    const quietInfo = console.info; console.info = () => {};
    try {
      await generateQAReport(raw, context, { client: one.client, model: 'plan', logLevel: 'off' });
      const result = await generateQAReport(raw, context, { client: many.client, model: 'plan', logLevel: 'off' }, { cluster: { read: readAt, readBase: (file: string) => { try { return execFileSync('git', ['-C', path.join(history!, entry.repo), 'show', `${entry.introducer.sha}^:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; } }, threshold: Number(flag('threshold', '15')), ...(flag('group-size') ? { maxGroupSize: Number(flag('group-size')) } : {}), ...(flag('max-groups') ? { maxGroups: Number(flag('max-groups')) } : {}) } });
      console.info = quietInfo;
      const groups = result.cluster?.groups ?? [];
      const reviews = many.sent.slice(0, groups.length || 1);
      if (flag('verbose')) console.log(`   related entities per group: ${groups.map(g => g.relatedEntities).join(',')}`);
      console.log(`${entry.id.padEnd(16)}${String(readEvidence(raw).impacts.length).padStart(7)}${String(groups.length || 1).padStart(8)}  ${(groups.map(g => g.changed).join(',') || 'single call').padEnd(30)} ${(groups.reduce((n, g) => n + g.relatedBytes, 0) / 1024).toFixed(0).padStart(8)} (${groups.filter(g => g.relatedTruncated).length})${kb(one.sent[0]!).padStart(16)}${kb(Math.max(...reviews)).padStart(18)}${kb(reviews.reduce((a, b) => a + b, 0)).padStart(18)}`);
    } catch (error) { console.info = quietInfo; console.log(`${entry.id.padEnd(16)} ERROR ${(error as Error).message.slice(0, 120)}`); }
  }
} else if (command === 'summary') {
  const rows = fs.readFileSync(RUNS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // --grades: hand grades (manual judging) replace catch/explained on matching (id, run) rows; --grades-model keeps one model's grades.
  if (flag('grades')) {
    const gradesModel = flag('grades-model');
    const grades = fs.readFileSync(path.resolve(flag('grades')!), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(g => !gradesModel || g.model === gradesModel);
    let matched = 0;
    for (const r of rows) {
      const g = grades.find(x => x.id === r.id && x.run === r.run);
      if (g) { r.catch = Boolean(g.catch); r.explained = Boolean(g.explained); r.area = Boolean(g.area); r.graded = 'hand'; matched += 1; }
    }
    console.log(`hand grades: ${matched}/${rows.length} rows matched from ${path.relative(ROOT, path.resolve(flag('grades')!))}${gradesModel ? ` (model ${gradesModel})` : ''}`);
  }
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
      meanChecks: rs.reduce((s, r) => s + (r.checks ?? (r.report?.testAreas ?? []).reduce((n: number, a: any) => n + (a.checks?.length ?? 0), 0)), 0) / (rs.length || 1),
    };
    // `audit.skipped` is 'invalid' for an unaudited report and, since V-13b, a count otherwise (so test the marker, not truthiness).
    const audited = rs.filter(r => r.audit && r.audit.skipped !== 'invalid');
    if (rs.some(r => r.usage.verifier)) {
      // Phase V: E3 silent drops (M3), E6 cost (M4), E7 "Not covered" size.
      byVariant[v].verifier = {
        cost: rs.reduce((s, r) => s + (r.usage.verifier?.cost ?? 0), 0), repairCost: rs.reduce((s, r) => s + (r.usage.repair?.cost ?? 0), 0),
        meanSeconds: rs.reduce((s, r) => s + (r.usage.verifier?.seconds ?? 0), 0) / (rs.length || 1),
        repairs: rs.filter(r => r.verification?.repairRequested).length, repairsAccepted: rs.filter(r => r.verification?.repairAccepted).length,
        refusals: rs.reduce((s, r) => s + (r.usage.verifier?.refusals ?? 0), 0), errors: rs.reduce((s, r) => s + (r.usage.verifier?.errors ?? 0), 0),
        audit: { reports: audited.length, production: audited.reduce((s, r) => s + r.audit.production, 0), covered: audited.reduce((s, r) => s + r.audit.covered, 0),
          fixedByRepair: audited.reduce((s, r) => s + r.audit.fixedByRepair, 0), notCovered: audited.reduce((s, r) => s + r.audit.notCovered, 0),
          silentDrops: audited.reduce((s, r) => s + r.audit.silentDrops, 0), lostInRepair: audited.reduce((s, r) => s + r.audit.lostInRepair, 0),
          strayNotCovered: audited.reduce((s, r) => s + r.audit.strayNotCovered, 0),
          // V-13b buckets (absent in data-v3 rows, so 0 there).
          skipped: audited.reduce((s, r) => s + (r.audit.skipped ?? 0), 0), folded: audited.reduce((s, r) => s + (r.audit.folded ?? 0), 0),
          // E7 counts the lines a reader sees (a folded inner function adds no line; V-13d groups a long list by file).
          // V-13e: plain checks plus any gap left by code name.
          reportsNotCoveredAtMost3: audited.filter(r => (r.report?.notCovered ? shownLines(r.report) : r.audit.notCovered) <= 3).length,
          reportsNotCoveredItemsAtMost3: audited.filter(r => (r.report?.notCovered?.length ?? r.audit.notCovered) <= 3).length,
          maxNotCoveredLines: Math.max(0, ...audited.map(r => shownLines(r.report ?? {}))),
          // E7 since 2026-11-20: at most 7 QA lines for the gaps in every report.
          reportsQaLinesAtMost7: audited.filter(r => shownLines(r.report ?? {}) <= 7).length,
          e7ListMet: audited.every(r => shownLines(r.report ?? {}) <= 7) },
      };
    }
    const b = byVariant[v];
    const vb = b.verifier ? ` | verifier $${b.verifier.cost.toFixed(3)} repairs ${b.verifier.repairs}/${b.reports} silent ${b.verifier.audit.silentDrops} notCovered ${b.verifier.audit.notCovered}` : '';
    console.log(`${v.padEnd(14)} valid ${pct(b.valid, b.reports)} catch ${pct(b.catch, b.reports)} explained ${pct(b.explained, b.reports)} | commits(majority) catch ${b.commitsMajorityCatch}/${b.commits} | lookups ${b.lookups.mean.toFixed(1)} | checks ${b.meanChecks.toFixed(1)} | $${b.cost.toFixed(2)}${vb}`);
  }
  const perCommit = facts.map(f => ({ id: f.id, repo: f.repo, changeClass: f.changeClass, hasContext: f.hasContext, payloadBytes: f.payloadBytes, impacts: f.impacts,
    truth: f.truth.map((t: any) => `${t.as}${t.inPayload ? '' : '(not in payload)'}${t.outside ? '*' : ''}`),
    ...Object.fromEntries(variants.map(v => { const rs = rows.filter(r => r.id === f.id && r.variant === v);
      return [v, { runs: rs.length, valid: rs.filter(r => r.valid).length, catch: rs.filter(r => r.catch).length, explained: rs.filter(r => r.explained).length, lookups: rs.reduce((s, r) => s + r.lookups.count, 0) }]; })) }));
  // Time and cost per report against payload size: one CSV row per report, and a table by size bucket.
  const sizeOf = (r: any) => r.payloadBytes ?? facts.find(f => f.id === r.id)?.payloadBytes ?? 0;
  const costOf = (r: any) => r.usage.report.cost + r.usage.judge.cost + (r.usage.verifier?.cost ?? 0);
  // M4 columns (empty for variants without the verifier): verifier tokens, cached tokens, seconds, cost; repair triggered and its writer cost.
  const csv = ['id,variant,run,payloadKB,seconds,reportCostUSD,judgeCostUSD,totalCostUSD,promptTokens,cachedTokens,completionTokens,llmCalls,lookups,valid,catch,explained,'
    + 'verifierInputTokens,verifierCachedTokens,verifierOutputTokens,verifierSeconds,verifierCostUSD,repair,repairCostUSD,notCovered,silentDrops',
    ...rows.map(r => [r.id, r.variant, r.run, Math.round(sizeOf(r) / 1024), r.seconds, r.usage.report.cost.toFixed(5), r.usage.judge.cost.toFixed(5), costOf(r).toFixed(5),
      r.usage.report.prompt, r.usage.report.cached, r.usage.report.completion, r.usage.report.calls, r.lookups.count, r.valid, Boolean(r.catch || r.draft?.catch), Boolean(r.explained),
      r.usage.verifier?.input ?? '', r.usage.verifier?.cached ?? '', r.usage.verifier?.output ?? '', r.usage.verifier?.seconds ?? '', r.usage.verifier?.cost.toFixed(5) ?? '',
      r.verification ? r.verification.repairRequested : '', r.usage.repair?.cost.toFixed(5) ?? '', r.audit?.notCovered ?? '', r.audit?.silentDrops ?? ''].join(','))];
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
  // R-0: results by change size. "Caught" = commits where at least one run caught the bug; "majority" = more than half the runs did.
  // Coverage = changed production functions the report covered (Phase V audit), so it is empty for variants without the verifier.
  const fnsOf = (id: string) => facts.find(f => f.id === id)?.impacts ?? 0;
  const fnBands: [string, number, number][] = [['<= 10', 0, 10], ['11-25', 11, 25], ['> 25', 26, Infinity]];
  const kbBands: [string, number, number][] = [['< 50 KB', 0, 50], ['50-250 KB', 50, 250], ['250-500 KB', 250, 500], ['500 KB-1 MB', 500, 1024], ['> 1 MB', 1024, Infinity]];
  const bandRow = (rs: any[]) => {
    const commits = [...new Set(rs.map(r => r.id))];
    const runsOf = (id: string) => rs.filter(r => r.id === id);
    const audited = rs.filter(r => r.audit && r.audit.skipped !== 'invalid');
    const production = audited.reduce((s, r) => s + r.audit.production, 0);
    const mean = (f: (r: any) => number) => (rs.length ? rs.reduce((s, r) => s + f(r), 0) / rs.length : 0);
    return { commits: commits.length, reports: rs.length, valid: rs.filter(r => r.valid).length,
      caught: commits.filter(id => runsOf(id).some(r => r.catch)).length,
      caughtMajority: commits.filter(id => { const c = runsOf(id); return c.filter(r => r.catch).length * 2 > c.length; }).length,
      explained: commits.filter(id => runsOf(id).some(r => r.explained)).length,
      catchReports: rs.filter(r => r.catch).length,
      coverage: production ? audited.reduce((s, r) => s + r.audit.covered, 0) / production : null,
      meanOutputTokens: Math.round(mean(r => r.usage.report.completion ?? 0)),
      meanChecks: mean(r => r.checks ?? 0), meanCost: mean(costOf), meanSeconds: Math.round(mean(r => r.seconds ?? 0)) };
  };
  const bands = variants.map(v => {
    const rs = rows.filter(r => r.variant === v);
    return { variant: v,
      byChangedFunctions: fnBands.map(([band, lo, hi]) => ({ band, ...bandRow(rs.filter(r => fnsOf(r.id) >= lo && fnsOf(r.id) <= hi)) })),
      byPayload: kbBands.map(([band, lo, hi]) => ({ band, ...bandRow(rs.filter(r => sizeOf(r) / 1024 >= lo && sizeOf(r) / 1024 < hi)) })) };
  });
  const printBands = (title: string, list: any[]) => {
    console.log(`\n${title}`);
    console.log(`${'band'.padEnd(12)} commits caught majority explained  valid  catch/reports  coverage  out tok  checks   mean $  mean s`);
    for (const b of list) console.log(`${b.band.padEnd(12)} ${String(b.commits).padStart(7)} ${String(b.caught).padStart(6)} ${String(b.caughtMajority).padStart(8)} ${String(b.explained).padStart(9)} ${`${b.valid}/${b.reports}`.padStart(6)} ${`${b.catchReports}/${b.reports}`.padStart(14)} ${(b.coverage === null ? '-' : `${Math.round(100 * b.coverage)}%`).padStart(9)} ${String(b.meanOutputTokens).padStart(8)} ${b.meanChecks.toFixed(1).padStart(7)} ${b.meanCost.toFixed(4).padStart(8)} ${String(b.meanSeconds).padStart(7)}`);
  };
  for (const b of bands) {
    printBands(`${b.variant}: by changed functions`, b.byChangedFunctions);
    printBands(`${b.variant}: by payload size (as sent)`, b.byPayload);
  }
  fs.writeFileSync(path.join(DATA, 'summary.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), reportModel: rows[0]?.model, judgeModel: JUDGE_MODEL, byVariant, costTime, bands, perCommit }, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, path.join(DATA, 'summary.json'))}`);
} else {
  console.log('Usage: evidence | run | summary. See the header of this file.');
}
