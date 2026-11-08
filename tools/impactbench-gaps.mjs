#!/usr/bin/env node
// Gap register: every thing Graphentra misses on a real commit gets a record, a cause and a pin.
// See impactbench/gaps/README.md.
//
// Usage: node tools/impactbench-gaps.mjs record <entry-id> [evidence.json]
//        node tools/impactbench-gaps.mjs check
//        node tools/impactbench-gaps.mjs summary
// `record` writes impactbench/runs/<entry-id>/graphentra-result.json from a saved evidence file.
// `check` fails on an invalid record, a miss with no gap, a fixed gap that came back, or an open
// gap whose entity is now found.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAPS = path.join(ROOT, 'impactbench/gaps/gaps.json');
const CORPUS = path.join(ROOT, 'impactbench/corpus/d0-corpus.json');
const RUNS = path.join(ROOT, 'impactbench/runs');
const LIMITATIONS = path.join(ROOT, 'packages/analyzer/src/output.ts');
const RESULT = 'graphentra-result.json';

const CAUSES = ['entity-collection', 'traversal-direction', 'data-flow', 'report-context', 'model-reasoning', 'truth-error'];
const STATUSES = ['open', 'planned', 'fixed', 'wontfix'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const missKey = (entry, entity) => `${entry} ${entity}`;

function loadResults() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).sort()
    .map((name) => path.join(RUNS, name, RESULT))
    .filter((file) => fs.existsSync(file))
    .map(readJson);
}

/** Which level each truth entity was flagged at: changed, blast, value, or null for a miss. */
function record(entryId, evidencePath) {
  const entry = readJson(CORPUS).find((item) => item.id === entryId);
  if (!entry) throw new Error(`No corpus entry ${entryId}`);
  const dir = path.join(RUNS, entryId);
  const evidence = readJson(evidencePath ?? path.join(dir, 'graphentra-evidence.json'));
  if (evidence.comparison?.resolvedHeadSha !== entry.introducer.sha) {
    throw new Error(`Evidence head ${evidence.comparison?.resolvedHeadSha} is not the introducer ${entry.introducer.sha}`);
  }
  const changed = new Set(evidence.impacts.map((impact) => impact.changedEntity.id));
  const blast = new Set(evidence.impacts.flatMap((impact) => impact.blastRadius.entities.map((item) => item.id)));
  const received = new Set(evidence.impacts.flatMap((impact) => (impact.receivesChangedValue ?? []).map((target) => target.entity.id)));
  const result = {
    entry: entryId,
    analyzerVersion: evidence.analyzerVersion,
    headSha: evidence.comparison.resolvedHeadSha,
    flaggedCounts: { changed: changed.size, blastOnly: [...blast].filter((id) => !changed.has(id)).length, valueOnly: [...received].filter((id) => !changed.has(id) && !blast.has(id)).length },
    truth: entry.affected.entities.map((item) => ({
      id: item.id,
      outsideIntroducerDiff: item.outsideIntroducerDiff,
      flagged: changed.has(item.id) ? 'changed' : blast.has(item.id) ? 'blast' : received.has(item.id) ? 'value' : null,
    })),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RESULT), `${JSON.stringify(result, null, 2)}\n`);
  const misses = result.truth.filter((item) => item.flagged === null).length;
  console.log(`${entryId}: ${result.truth.length - misses}/${result.truth.length} truth entities flagged, written to ${RESULT}`);
}

function validateGap(gap, corpus, limitationSource, errors) {
  const at = gap.id ?? '(no id)';
  if (!/^GAP-\d{3}$/.test(gap.id ?? '')) errors.push(`${at}: id must look like GAP-001`);
  if (!gap.title) errors.push(`${at}: title is required`);
  if (!gap.evidence) errors.push(`${at}: evidence is required`);
  if (!CAUSES.includes(gap.cause)) errors.push(`${at}: cause must be one of ${CAUSES.join(', ')}`);
  if (!STATUSES.includes(gap.status)) errors.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
  if (!gap.foundIn?.length) errors.push(`${at}: foundIn needs at least one corpus entry`);
  for (const id of gap.foundIn ?? []) if (!corpus.has(id)) errors.push(`${at}: foundIn ${id} is not in the corpus`);
  for (const { entry, entity } of gap.missed ?? []) {
    if (!gap.foundIn?.includes(entry)) errors.push(`${at}: missed entry ${entry} is not in foundIn`);
    if (!corpus.get(entry)?.affected.entities.some((item) => item.id === entity)) {
      errors.push(`${at}: ${entity} is not a truth entity of ${entry}`);
    }
  }
  if (!gap.pinnedBy && !gap.pinExempt) errors.push(`${at}: needs pinnedBy, or pinExempt with a reason`);
  if (gap.pinnedBy) {
    const [file, name] = gap.pinnedBy.split(' :: ');
    const full = path.join(ROOT, file ?? '');
    if (!file || !name) errors.push(`${at}: pinnedBy must be "<file> :: <test name>"`);
    else if (!fs.existsSync(full)) errors.push(`${at}: pinned file ${file} does not exist`);
    else if (!fs.readFileSync(full, 'utf8').includes(name)) errors.push(`${at}: no test named "${name}" in ${file}`);
  }
  if (gap.status === 'fixed' && !gap.fixedIn) errors.push(`${at}: a fixed gap needs fixedIn`);
  if (gap.status === 'fixed' && !gap.pinnedBy) errors.push(`${at}: a fixed gap needs pinnedBy, so it cannot come back unseen`);
  if (gap.limitation && !limitationSource.includes(gap.limitation)) {
    errors.push(`${at}: limitation is not a sentence in packages/analyzer/src/output.ts`);
  }
}

function check() {
  const gaps = readJson(GAPS);
  const corpus = new Map(readJson(CORPUS).map((entry) => [entry.id, entry]));
  const limitationSource = fs.readFileSync(LIMITATIONS, 'utf8');
  const results = loadResults();
  const errors = [];
  const warnings = [];

  const seen = new Set();
  for (const gap of gaps) {
    if (seen.has(gap.id)) errors.push(`${gap.id}: duplicate id`);
    seen.add(gap.id);
    validateGap(gap, corpus, limitationSource, errors);
    if (gap.status === 'open' && !gap.roadmapTask) warnings.push(`${gap.id}: no roadmap task yet`);
    if (gap.status === 'open' && !gap.limitation) warnings.push(`${gap.id}: not disclosed in the evidence limitations`);
  }

  const gapByMiss = new Map(gaps.flatMap((gap) => (gap.missed ?? []).map(({ entry, entity }) => [missKey(entry, entity), gap])));
  for (const result of results) {
    const entry = corpus.get(result.entry);
    const truthNow = entry?.affected.entities.map((item) => item.id).sort().join(' ');
    if (truthNow !== result.truth.map((item) => item.id).sort().join(' ')) {
      errors.push(`${result.entry}: result does not match the corpus truth; run record again`);
      continue;
    }
    for (const { id, flagged } of result.truth) {
      const gap = gapByMiss.get(missKey(result.entry, id));
      if (flagged === null && !gap) errors.push(`${result.entry}: miss on ${id} has no gap record`);
      if (flagged === null && gap?.status === 'fixed') errors.push(`${gap.id}: marked fixed, but ${id} is missed again on ${result.entry}`);
      if (flagged !== null && gap && gap.status !== 'fixed') errors.push(`${gap.id}: ${id} is now found on ${result.entry}; close the gap`);
    }
  }

  for (const line of warnings) console.log(`warning: ${line}`);
  for (const line of errors) console.error(`error: ${line}`);
  console.log(`${gaps.length} gaps, ${results.length}/${corpus.size} corpus entries recorded, ${errors.length} errors, ${warnings.length} warnings`);
  if (errors.length) process.exitCode = 1;
}

function summary() {
  const gaps = readJson(GAPS);
  const corpus = readJson(CORPUS);
  const results = loadResults();
  console.log('| Cause | Open | Fixed | Entries |');
  console.log('|---|---|---|---|');
  for (const cause of CAUSES) {
    const group = gaps.filter((gap) => gap.cause === cause);
    if (!group.length) continue;
    const entries = new Set(group.flatMap((gap) => gap.foundIn));
    const open = group.filter((gap) => gap.status === 'open' || gap.status === 'planned').length;
    console.log(`| ${cause} | ${open} | ${group.filter((gap) => gap.status === 'fixed').length} | ${entries.size} |`);
  }
  console.log('');
  for (const gap of gaps) console.log(`${gap.id} [${gap.status}] ${gap.cause}: ${gap.title}`);
  const truth = results.flatMap((result) => result.truth);
  const outside = truth.filter((item) => item.outsideIntroducerDiff);
  const found = (items) => items.filter((item) => item.flagged !== null).length;
  console.log('');
  console.log(`Recorded ${results.length}/${corpus.length} entries. Entity recall ${found(truth)}/${truth.length}, outside the diff ${found(outside)}/${outside.length}.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'record' && args[0]) record(args[0], args[1]);
else if (command === 'check') check();
else if (command === 'summary') summary();
else {
  console.error('Usage: impactbench-gaps.mjs record <entry-id> [evidence.json] | check | summary');
  process.exitCode = 2;
}
