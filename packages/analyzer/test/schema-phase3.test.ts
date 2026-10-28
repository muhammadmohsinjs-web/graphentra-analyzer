import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepository, validateEvidenceEnvelope, type DeterministicEvidence } from '../src/index';
import { createRepo } from './helpers/git-fixture';

const BASE = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
const HEAD = BASE.replace('return 1;', 'return 2;');

function run(engine: 'legacy' | 'extended'): DeterministicEvidence {
  const repo = createRepo('graphentra-p3-');
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
const coords = (id: string) => ({ id, file: 'src/gone.ts', startLine: 1, endLine: 3 });

function full(): DeterministicEvidence {
  const evidence = clone(run('extended'));
  const changed = evidence.changedEntities[0];
  changed.changeKind = 'modified';
  changed.changeClasses = ['body', 'signature'];
  changed.edgeDeltas = {
    added: [{ from: 'a', to: 'b', type: 'CALLS' }, { from: 'a', to: 'c', type: 'CALLS' }],
    removed: [{ from: 'a', to: 'b', type: 'CALLS' }],
  };
  evidence.impacts[0].contractRisk = true;
  for (const path of evidence.impacts[0].blastRadius.paths) if (path.depth === 1) path.contractRisk = true;
  evidence.baseEntities = [coords('src/gone.ts#a'), coords('src/gone.ts#b')];
  evidence.skippedEntities = [{ entityId: 'src/x.ts#a', reason: 'cosmetic' }, { entityId: 'src/x.ts#b', reason: 'test_only' }];
  return evidence;
}

test('2.1 envelope with every phase 3 field validates', () => {
  assert.deepEqual(errorsOf(full()), []);
});

test('deleted entity needs baseEntity listed in baseEntities and may be absent from the graph', () => {
  const evidence = full();
  const changed = evidence.changedEntities[0];
  const deletedId = changed.entity.id;
  evidence.technicalGraph.entities = evidence.technicalGraph.entities.filter(entity => entity.id !== deletedId);
  evidence.technicalGraph.relations = evidence.technicalGraph.relations.filter(r => r.from !== deletedId && r.to !== deletedId);
  changed.changeKind = 'deleted';
  changed.baseEntity = coords(deletedId);
  evidence.baseEntities = [coords(deletedId)];
  evidence.impacts[0].blastRadius = { totalAffectedEntities: 0, entities: [], paths: [] };
  evidence.impacts[0].directDependents = [];
  evidence.impacts[0].terminalDependents = [];
  assert.deepEqual(errorsOf(evidence), []);

  const noBase = clone(evidence);
  delete noBase.changedEntities[0].baseEntity;
  assert.ok(errorsOf(noBase).some(e => e.includes('baseEntity is required when changeKind is "deleted"')));

  const unlisted = clone(evidence);
  unlisted.baseEntities = [];
  assert.ok(errorsOf(unlisted).some(e => e.includes('must appear in baseEntities')));
});

test('renamed entity requires baseEntity', () => {
  const evidence = full();
  evidence.changedEntities[0].changeKind = 'renamed';
  assert.ok(errorsOf(evidence).some(e => e.includes('baseEntity is required when changeKind is "renamed"')));
  evidence.changedEntities[0].baseEntity = coords('src/old.ts#x');
  assert.deepEqual(errorsOf(evidence), []);
});

test('changeClasses must be known, sorted, and unique', () => {
  const unsorted = full();
  unsorted.changedEntities[0].changeClasses = ['signature', 'body'];
  assert.ok(errorsOf(unsorted).some(e => e.includes('changeClasses must be sorted ascending and unique')));
  const duplicate = full();
  duplicate.changedEntities[0].changeClasses = ['body', 'body']; // rejected structurally by uniqueItems
  assert.equal(validateEvidenceEnvelope(duplicate).valid, false);
  const unknown = full();
  unknown.changedEntities[0].changeClasses = ['bogus'] as never;
  assert.equal(validateEvidenceEnvelope(unknown).valid, false);
});

test('edgeDeltas must be sorted by from|type|to and unique', () => {
  const unsorted = full();
  unsorted.changedEntities[0].edgeDeltas!.added.reverse();
  assert.ok(errorsOf(unsorted).some(e => e.includes('edgeDeltas.added must be sorted')));
  const dup = full();
  dup.changedEntities[0].edgeDeltas!.removed.push({ from: 'a', to: 'b', type: 'CALLS' });
  assert.ok(errorsOf(dup).some(e => e.includes('edgeDeltas.removed must be sorted')));
});

test('baseEntities and skippedEntities must be sorted', () => {
  const bases = full();
  bases.baseEntities!.reverse();
  assert.ok(errorsOf(bases).some(e => e.includes('baseEntities must be sorted by id')));
  const dupBases = full();
  dupBases.baseEntities![1] = dupBases.baseEntities![0];
  assert.ok(errorsOf(dupBases).some(e => e.includes('baseEntities must be sorted by id')));
  const skipped = full();
  skipped.skippedEntities!.reverse();
  assert.ok(errorsOf(skipped).some(e => e.includes('skippedEntities must be sorted')));
});

test('schema 2.0 rejects phase 3 fields', () => {
  const legacy = run('legacy');
  assert.deepEqual(errorsOf(legacy), []);
  const withBase = clone(legacy);
  withBase.baseEntities = [];
  assert.ok(errorsOf(withBase).some(e => e.includes('baseEntities is not allowed in schema 2.0')));
  const withKind = clone(legacy);
  withKind.changedEntities[0].changeKind = 'modified';
  assert.ok(errorsOf(withKind).some(e => e.includes('changeKind is not allowed in schema 2.0')));
  const withRisk = clone(legacy);
  withRisk.impacts[0].contractRisk = true;
  assert.ok(errorsOf(withRisk).some(e => e.includes('contractRisk is not allowed in schema 2.0')));
});
