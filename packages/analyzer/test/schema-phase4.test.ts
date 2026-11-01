import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepository, validateEvidenceEnvelope, type DeterministicEvidence } from '../src/index';
import { createRepo } from './helpers/git-fixture';

const BASE = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
const HEAD = BASE.replace('return 1;', 'return 2;');

function run(engine: 'legacy' | 'extended'): DeterministicEvidence {
  const repo = createRepo('graphentra-p4-');
  try {
    const base = repo.commitFile('src/app.ts', BASE, 'c1');
    const head = repo.commitFile('src/app.ts', HEAD, 'c2');
    return analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine }).evidence;
  } finally {
    repo.cleanup();
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const errorsOf = (evidence: DeterministicEvidence): string[] => validateEvidenceEnvelope(evidence).errors;
const row = (key: string) => ({ key, changedLines: 4, attributedLines: 3, ratio: 0.75, frontierCount: 1 });

function full(): DeterministicEvidence {
  const evidence = clone(run('extended'));
  evidence.technicalGraph.relations[0].confidence = 'likely';
  const impact = evidence.impacts[0];
  impact.confidence = 'likely';
  for (const path of impact.blastRadius.paths) path.confidence = 'proven';
  impact.blastRadius.hubs = [{ entityId: 'src/a.ts#a', fanIn: 30, reach: 40 }, { entityId: 'src/a.ts#b', fanIn: 25, reach: 25 }];
  evidence.frontier = [
    { entityId: 'src/a.ts#a', file: 'src/a.ts', line: 3, reason: 'eval' },
    { entityId: 'src/a.ts#a', file: 'src/a.ts', line: 9, reason: 'any_typed_call' },
    { entityId: 'src/a.ts#a', file: 'src/a.ts', line: 9, reason: 'di_token' },
    { entityId: 'src/b.ts#b', file: 'src/b.ts', line: 1, reason: 'dynamic_import' },
  ];
  evidence.coverage = {
    byLanguage: [row('javascript'), row('typescript')],
    byDirectory: [row('.'), row('src')],
    skippedFiles: [{ file: 'a.bin', reason: 'binary' }, { file: 'b.ts', reason: 'too_large' }],
    frontierTotal: 4,
  };
  return evidence;
}

test('2.1 envelope with every phase 4 field validates', () => {
  assert.deepEqual(errorsOf(full()), []);
});

test('confidence must be a known level', () => {
  const edge = full();
  edge.technicalGraph.relations[0].confidence = 'unknown' as never;
  assert.equal(validateEvidenceEnvelope(edge).valid, false);
  const path = full();
  path.impacts[0].blastRadius.paths[0].confidence = 'unknown' as never;
  assert.equal(validateEvidenceEnvelope(path).valid, false);
  const impact = full();
  impact.impacts[0].confidence = 'unknown' as never;
  assert.equal(validateEvidenceEnvelope(impact).valid, false);
});

test('frontier reason must be known and items sorted by file, line, reason, entityId', () => {
  const unknown = full();
  unknown.frontier![0].reason = 'bogus' as never;
  assert.equal(validateEvidenceEnvelope(unknown).valid, false);
  const byFile = full();
  byFile.frontier!.reverse();
  assert.ok(errorsOf(byFile).some(e => e.includes('frontier must be sorted')));
  const byReason = full();
  [byReason.frontier![1], byReason.frontier![2]] = [byReason.frontier![2], byReason.frontier![1]];
  assert.ok(errorsOf(byReason).some(e => e.includes('frontier must be sorted')));
  const byEntity = full();
  byEntity.frontier![2] = { ...byEntity.frontier![1], entityId: 'src/a.ts#0' };
  assert.ok(errorsOf(byEntity).some(e => e.includes('frontier must be sorted')));
  const badLine = full();
  badLine.frontier![0].line = -1;
  assert.equal(validateEvidenceEnvelope(badLine).valid, false);
});

test('hubs must be sorted by entityId and have non-negative integer counts', () => {
  const unsorted = full();
  unsorted.impacts[0].blastRadius.hubs!.reverse();
  assert.ok(errorsOf(unsorted).some(e => e.includes('hubs must be sorted by entityId')));
  const dup = full();
  dup.impacts[0].blastRadius.hubs![1] = dup.impacts[0].blastRadius.hubs![0];
  assert.ok(errorsOf(dup).some(e => e.includes('hubs must be sorted by entityId')));
  const negative = full();
  negative.impacts[0].blastRadius.hubs![0].fanIn = -1;
  assert.equal(validateEvidenceEnvelope(negative).valid, false);
  const fractional = full();
  fractional.impacts[0].blastRadius.hubs![0].reach = 1.5;
  assert.equal(validateEvidenceEnvelope(fractional).valid, false);
});

test('coverage rows and skipped files must be sorted', () => {
  const language = full();
  language.coverage!.byLanguage.reverse();
  assert.ok(errorsOf(language).some(e => e.includes('coverage.byLanguage must be sorted by key')));
  const directory = full();
  directory.coverage!.byDirectory.reverse();
  assert.ok(errorsOf(directory).some(e => e.includes('coverage.byDirectory must be sorted by key')));
  const skipped = full();
  skipped.coverage!.skippedFiles.reverse();
  assert.ok(errorsOf(skipped).some(e => e.includes('coverage.skippedFiles must be sorted by file')));
});

test('coverage ratio, counts and skip reasons are checked', () => {
  const high = full();
  high.coverage!.byLanguage[0].ratio = 1.1;
  assert.equal(validateEvidenceEnvelope(high).valid, false);
  const low = full();
  low.coverage!.byDirectory[0].ratio = -0.1;
  assert.equal(validateEvidenceEnvelope(low).valid, false);
  const lines = full();
  lines.coverage!.byLanguage[0].changedLines = -1;
  assert.equal(validateEvidenceEnvelope(lines).valid, false);
  const fractional = full();
  fractional.coverage!.byLanguage[0].frontierCount = 0.5;
  assert.equal(validateEvidenceEnvelope(fractional).valid, false);
  const total = full();
  total.coverage!.frontierTotal = -1;
  assert.equal(validateEvidenceEnvelope(total).valid, false);
  const reason = full();
  reason.coverage!.skippedFiles[0].reason = 'bogus' as never;
  assert.equal(validateEvidenceEnvelope(reason).valid, false);
});

test('schema 2.0 rejects phase 4 fields', () => {
  const legacy = run('legacy');
  assert.deepEqual(errorsOf(legacy), []);
  const edge = clone(legacy);
  edge.technicalGraph.relations[0].confidence = 'proven';
  assert.ok(errorsOf(edge).some(e => e.includes('relations[0].confidence is not allowed in schema 2.0')));
  const path = clone(legacy);
  path.impacts[0].blastRadius.paths[0].confidence = 'proven';
  assert.ok(errorsOf(path).some(e => e.includes('paths[0].confidence is not allowed in schema 2.0')));
  const impact = clone(legacy);
  impact.impacts[0].confidence = 'proven';
  assert.ok(errorsOf(impact).some(e => e.includes('impacts[0].confidence is not allowed in schema 2.0')));
  const hubs = clone(legacy);
  hubs.impacts[0].blastRadius.hubs = [];
  assert.ok(errorsOf(hubs).some(e => e.includes('hubs is not allowed in schema 2.0')));
  const frontier = clone(legacy);
  frontier.frontier = [];
  assert.ok(errorsOf(frontier).some(e => e.includes('frontier is not allowed in schema 2.0')));
  const coverage = clone(legacy);
  coverage.coverage = { byLanguage: [], byDirectory: [], skippedFiles: [], frontierTotal: 0 };
  assert.ok(errorsOf(coverage).some(e => e.includes('coverage is not allowed in schema 2.0')));
});
