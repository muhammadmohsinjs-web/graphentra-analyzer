#!/usr/bin/env node
// Phase V · V-1: build the hand-labelled verifier set (impactbench/verifier/labels.jsonl).
//
//   node --import tsx tools/verifier-labels.mts build --work <dir>     # <dir>/evidence/<id>.json from impactbench-report-eval.mts evidence
//   node --import tsx tools/verifier-labels.mts stats
//
// Every item carries a DRAFT label from a stated rule (labelSource) and reviewed:false. A person reviews each item, fixes the
// label or reason if needed, and sets reviewed:true. A rebuild keeps reviewed items as they are (matched by id).
// Rules and question wording: impactbench/verifier/README.md.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'impactbench/verifier');
const LABELS = path.join(DIR, 'labels.jsonl');
const INVERSIONS = path.join(DIR, 'inversions.json');
const RUN_FILES: Array<[string, string]> = [['v2', 'impactbench/eval/data-v2/runs.jsonl'], ['v1', 'impactbench/eval/data/runs.jsonl']];

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

// Target counts per question kind (README: ~60 coverage, ~50 triggering input, ~40 faithfulness).
const TARGET = { coverage: { pos: 30, realNeg: 15, crossNeg: 15 }, trigger: { pos: 25, neg: 25 }, faithfulness: { pos: 20, crossNeg: 10 } };
const CODE_CAP = 4000; // characters per side (BEFORE / AFTER) per change
const EVIDENCE_CAP = 24000; // characters of change summaries for a faithfulness item

export type Kind = 'coverage' | 'trigger' | 'faithfulness';
export type Item = {
  id: string; kind: Kind; commit: string; repo: string; report: string; entity?: string; claim?: string;
  question: string; input: string;
  label: boolean; // true = covered / triggering input present / supported. The verifier flags label=false items.
  reason: string; labelSource: string; reviewed: boolean;
};

export const QUESTIONS: Record<Kind, string> = {
  coverage: 'Look at the QA REPORT and the CHANGE (BEFORE is the old code, AFTER is the new code). Answer true if at least one key change, QA check or test area in the report describes or tests the behaviour that changed in this CHANGE. Answer false if the report never addresses this behaviour, or only mentions it as unrelated context.',
  trigger: 'Look at the QA REPORT and the CHANGE (BEFORE is the old code, AFTER is the new code). Find every input or condition under which AFTER behaves differently from BEFORE, including unintended differences and edge cases (a timeout with no follow-up event, zero or empty values, special characters, a different order of events, a missing field). Answer true only if at least one QA check, done exactly as written, uses such an input and would show a user-visible difference. Answer false if the checks only use inputs where BEFORE and AFTER behave the same, or name the right area without the input that triggers the difference.',
  faithfulness: 'Look at the CLAIM and the EVIDENCE (BEFORE is the old code, AFTER is the new code). Answer true only if the claim is supported by the code changes in the evidence and describes old and new behaviour the right way round. Answer false if the claim is not supported, describes a change that is not in the evidence, or swaps before and after.',
};

type Truth = { id: string; role: string; outsideIntroducerDiff: boolean };
type Entry = { id: string; repo: string; symptom: string; affected: { entities: Truth[]; areas: string[] } };
type Row = { id: string; repo: string; variant: string; run: number; valid?: boolean; catch?: boolean; area?: boolean; explained?: boolean; why?: string; hits?: number[]; report?: any };
type Change = { id: string; file: string; before: string; after: string; paths: string[] };

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const order = <T>(list: T[], key: (item: T) => string) => [...list].sort((a, b) => hash(key(a)).localeCompare(hash(key(b))));
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters cut]` : text);
const lines = (code: unknown) => (Array.isArray(code) ? code.join('\n') : typeof code === 'string' ? code : '');

function changesOf(evidence: any): Map<string, Change> {
  const out = new Map<string, Change>();
  for (const impact of evidence.impacts ?? []) {
    const entity = impact.changedEntity;
    const paths = (impact.blastRadius?.paths ?? []).slice(0, 3).map((p: any) => p.path.map((e: any) => e.name).join(' -> '));
    out.set(entity.id, { id: entity.id, file: impact.change.file, before: lines(impact.change.removedCode), after: lines(impact.change.addedCode), paths });
  }
  return out;
}

export function renderReport(report: any): string {
  const list = (items: string[] = []) => items.map((text, i) => `${i + 1}. ${text}`).join('\n') || '(none)';
  const areas = (report.testAreas ?? []).map((a: any) => `- ${a.area}${a.setup ? ` (setup: ${a.setup})` : ''}\n${(a.checks ?? []).map((c: string) => `  * ${c}`).join('\n')}`).join('\n');
  return [`QA REPORT`, `Summary: ${report.summary ?? ''}`, `Key changes:\n${list(report.keyChanges)}`, `QA checks:\n${list(report.qaChecks)}`,
    `Test areas:\n${areas || '(none)'}`, `Uncertainty:\n${list(report.uncertainty)}`].join('\n\n');
}

export function renderChange(change: Change, label = 'CHANGE'): string {
  return [`${label} ${change.id} (${change.file})`, `BEFORE (removed code):\n${cap(change.before, CODE_CAP) || '(nothing removed)'}`,
    `AFTER (added code):\n${cap(change.after, CODE_CAP) || '(nothing added)'}`, change.paths.length ? `Used by:\n${change.paths.map(p => `- ${p}`).join('\n')}` : ''].filter(Boolean).join('\n');
}

function build() {
  const work = flag('work'); if (!work) throw new Error('--work <dir> is required');
  const corpus: Entry[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'impactbench/corpus/d0-corpus.json'), 'utf8'));
  const byId = new Map(corpus.map(e => [e.id, e]));
  const changes = new Map<string, Map<string, Change>>();
  for (const entry of corpus) {
    const file = path.join(path.resolve(work), 'evidence', `${entry.id}.json`);
    if (fs.existsSync(file)) changes.set(entry.id, changesOf(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  // The changed truth entity the verifier would be asked about: first fault, else any changed truth entity.
  const target = (entry: Entry) => {
    const changed = changes.get(entry.id); if (!changed) return undefined;
    const truth = [...entry.affected.entities].sort((a, b) => Number(b.role === 'fault') - Number(a.role === 'fault'));
    return truth.map(t => changed.get(t.id)).find(Boolean);
  };
  const reports = RUN_FILES.flatMap(([src, file]) => fs.readFileSync(path.join(ROOT, file), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Row)
    .filter(r => r.valid !== false && r.report?.testAreas && typeof r.catch === 'boolean' && changes.has(r.id))
    .map(r => ({ ...r, key: `${src}-${r.variant}-${r.run}`, src })));
  const items: Item[] = [];
  const item = (kind: Kind, r: (typeof reports)[number], extra: Partial<Item> & Pick<Item, 'input' | 'label' | 'reason' | 'labelSource'>, n = 0) => {
    items.push({ id: `${kind}:${r.id}:${r.key}${extra.entity && kind !== 'faithfulness' ? '' : `:${n}`}`, kind, commit: r.id, repo: r.repo, report: r.key, question: QUESTIONS[kind], reviewed: false, ...extra });
  };
  // Round-robin over commits so one commit cannot fill a class; v2 (the current baseline) before v1.
  const spread = <T extends { id: string; key: string; src: string }>(list: T[], count: number) => {
    const groups = new Map<string, T[]>();
    for (const r of order(list, r => `${r.id}|${r.key}`).sort((a, b) => Number(a.src !== 'v2') - Number(b.src !== 'v2'))) groups.set(r.id, [...(groups.get(r.id) ?? []), r]);
    const out: T[] = [];
    for (let round = 0; out.length < count && round < 20; round += 1) for (const group of groups.values()) if (group[round] && out.length < count) out.push(group[round]);
    return out;
  };
  const withTarget = reports.filter(r => target(byId.get(r.id)!));

  // U2 · triggering input. Label = the ImpactBench judge's `catch`: some QA check, with its stated input, would fail on the build with the regression.
  for (const r of [...spread(withTarget.filter(r => r.catch), TARGET.trigger.pos), ...spread(withTarget.filter(r => !r.catch), TARGET.trigger.neg)]) {
    const change = target(byId.get(r.id)!)!;
    item('trigger', r, { entity: change.id, input: `${renderReport(r.report)}\n\n${renderChange(change)}`, label: r.catch!,
      reason: r.catch ? `Judge: check ${(r.hits ?? []).join(', ') || '?'} exposes the regression (${byId.get(r.id)!.symptom})` : `Judge: no check uses the triggering input. ${r.why ?? ''}`.trim(),
      labelSource: 'judge-catch' });
  }

  // U1 · coverage. Positive: judge `area` true for the commit's own changed truth entity. Real negative: judge `area` false.
  // Cross negative: the report of commit A asked about the changed truth entity of another commit B in the same repo.
  for (const r of spread(withTarget.filter(r => r.area), TARGET.coverage.pos)) {
    const change = target(byId.get(r.id)!)!;
    item('coverage', r, { entity: change.id, input: `${renderReport(r.report)}\n\n${renderChange(change)}`, label: true, reason: 'Judge: the report points the tester at the affected area of this change.', labelSource: 'judge-area' });
  }
  for (const r of spread(withTarget.filter(r => !r.area), TARGET.coverage.realNeg)) {
    const change = target(byId.get(r.id)!)!;
    item('coverage', r, { entity: change.id, input: `${renderReport(r.report)}\n\n${renderChange(change)}`, label: false, reason: `Judge: the report does not point at the affected area. ${r.why ?? ''}`.trim(), labelSource: 'judge-area' });
  }
  let crossCount = 0;
  for (const r of spread(reports.filter(r => r.src === 'v2'), 40)) {
    if (crossCount >= TARGET.coverage.crossNeg) break;
    const entry = byId.get(r.id)!;
    const ownIds = new Set([...entry.affected.entities.map(t => t.id), ...(changes.get(r.id)?.keys() ?? [])]);
    const other = order(corpus.filter(e => e.repo === r.repo && e.id !== r.id && changes.has(e.id)), e => `${r.id}|${e.id}`)
      .map(e => ({ e, change: target(e) })).find(o => o.change && !ownIds.has(o.change.id) && !o.e.affected.areas.some(a => entry.affected.areas.includes(a)));
    if (!other) continue;
    item('coverage', { ...r, key: `${r.key}-x-${other.e.id}` }, { entity: other.change!.id, input: `${renderReport(r.report)}\n\n${renderChange(other.change!)}`, label: false,
      reason: `Constructed: the report is for ${r.id}; the change is from ${other.e.id} (${other.e.affected.areas.join(', ')}), which the report does not address.`, labelSource: 'cross-commit' });
    crossCount += 1;
  }

  // U3 · faithfulness. Positive: a key change of a valid v2 report, checked against its own evidence (draft: supported).
  // Cross negative: a key change of another commit in the same repo. Inverted negatives come from inversions.json (hand-written).
  const evidenceText = (id: string) => cap([...changes.get(id)!.values()].map(c => renderChange(c)).join('\n\n'), EVIDENCE_CAP);
  const v2 = reports.filter(r => r.src === 'v2');
  for (const r of spread(v2, TARGET.faithfulness.pos)) {
    const claim = r.report.keyChanges?.[0]; if (!claim) continue;
    item('faithfulness', r, { claim, input: `CLAIM: ${claim}\n\nEVIDENCE\n${evidenceText(r.id)}`, label: true, reason: 'Draft: key change from a report that passed schema and before/after validation. Reviewer must confirm it matches the code.', labelSource: 'draft-own-report' });
  }
  let crossClaims = 0;
  for (const r of spread(v2, 40)) {
    if (crossClaims >= TARGET.faithfulness.crossNeg) break;
    const donor = order(v2.filter(o => o.repo === r.repo && o.id !== r.id), o => `${r.id}|${o.id}`)[0];
    const claim = donor?.report.keyChanges?.[0]; if (!claim) continue;
    item('faithfulness', { ...r, key: `${r.key}-x-${donor.id}` }, { claim, input: `CLAIM: ${claim}\n\nEVIDENCE\n${evidenceText(r.id)}`, label: false,
      reason: `Constructed: the claim describes ${donor.id}, not this commit's changes.`, labelSource: 'cross-commit' }, 1);
    crossClaims += 1;
  }
  const inversions: Array<{ commit: string; report: string; original: string; claim: string; why: string }> = fs.existsSync(INVERSIONS) ? JSON.parse(fs.readFileSync(INVERSIONS, 'utf8')) : [];
  for (const [n, inv] of inversions.entries()) {
    const r = reports.find(x => x.id === inv.commit && x.key === inv.report); if (!r) throw new Error(`inversion ${n}: report ${inv.commit} ${inv.report} not found`);
    item('faithfulness', { ...r, key: `${r.key}-inv` }, { claim: inv.claim, input: `CLAIM: ${inv.claim}\n\nEVIDENCE\n${evidenceText(r.id)}`, label: false, reason: `Hand-written inversion of "${inv.original}": ${inv.why}`, labelSource: 'inversion' }, n + 2);
  }

  // Keep reviewed items as the reviewer left them.
  const previous = fs.existsSync(LABELS) ? fs.readFileSync(LABELS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Item) : [];
  const reviewed = new Map(previous.filter(p => p.reviewed).map(p => [p.id, p]));
  const seen = new Set<string>();
  const final = items.filter(i => !seen.has(i.id) && seen.add(i.id)).map(i => {
    const p = reviewed.get(i.id);
    return p ? { ...i, label: p.label, reason: p.reason, reviewed: true } : i;
  });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LABELS, `${final.map(i => JSON.stringify(i)).join('\n')}\n`);
  console.log(`wrote ${final.length} items (${reviewed.size} reviewed kept) to ${path.relative(ROOT, LABELS)}`);
  stats(final);
}

function stats(items: Item[] = fs.readFileSync(LABELS, 'utf8').trim().split('\n').map(l => JSON.parse(l))) {
  for (const kind of ['coverage', 'trigger', 'faithfulness'] as Kind[]) {
    const k = items.filter(i => i.kind === kind);
    const src = [...new Set(k.map(i => i.labelSource))].map(s => `${s} ${k.filter(i => i.labelSource === s).length}`).join(', ');
    console.log(`${kind.padEnd(12)} ${String(k.length).padStart(3)} items · true ${k.filter(i => i.label).length} · false ${k.filter(i => !i.label).length} · commits ${new Set(k.map(i => i.commit)).size} · reviewed ${k.filter(i => i.reviewed).length} · ${src}`);
  }
  const big = Math.max(...items.map(i => i.input.length));
  console.log(`largest input ${Math.round(big / 1024)} KB`);
}

if (command === 'build') build();
else if (command === 'stats') stats();
else if (command) throw new Error(`unknown command ${command}`);
