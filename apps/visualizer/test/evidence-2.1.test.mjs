import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareData, buildTraversal, layoutGraph, kindOf, kindClass, displayName } from '../public/model.mjs';

const load = () => JSON.parse(readFileSync(new URL('./fixtures/evidence-2.1.json', import.meta.url), 'utf8'));

function input(evidence) {
  const graph = evidence.technicalGraph;
  return {
    evidence, graph, warnings: [],
    analysis: { schemaVersion: '1.1', repository: { headSha: graph.repository.headSha }, changedFiles: evidence.changedFiles,
      changedEntities: evidence.changedEntities, impacts: evidence.impacts, limitations: evidence.limitations },
  };
}

test('model accepts evidence 2.1 and exposes its schema version and entity kinds', () => {
  const evidence = load();
  assert.equal(evidence.schemaVersion, '2.1');
  const model = prepareData(input(evidence));
  assert.equal(model.schemaVersion, '2.1');
  const kinds = new Set([...model.entities.values()].map(kindOf));
  assert.ok(kinds.has('module') && kinds.has('function'));
  assert.ok(model.analysis.impacts.length > 0);
  assert.ok(buildTraversal(model, [model.analysis.impacts[0].changedEntity.id]).depths.size >= 1);
  assert.ok(layoutGraph(model.entities).groups.length > 0);
});

test('model still rejects unknown evidence versions', () => {
  const evidence = load();
  evidence.schemaVersion = '2.2';
  assert.throws(() => prepareData(input(evidence)), /Invalid evidence envelope/);
});

test('an unknown or missing kind does not crash the model and falls back to the generic style', () => {
  const evidence = load();
  evidence.technicalGraph.entities[0].kind = 'future-kind!';
  delete evidence.technicalGraph.entities[1].kind;
  const data = input(evidence);
  data.analysis = null;
  const model = prepareData(data);
  const [first, second] = model.entities.values();
  assert.equal(kindOf(first), 'future-kind!');
  assert.equal(kindClass(first), 'kind-future-kind');
  assert.equal(kindOf(second), 'function');
  assert.equal(kindClass(second), 'kind-function');
  assert.equal(kindClass({ kind: '!!' }), 'kind-unknown');
  assert.equal(layoutGraph(model.entities).positions.size, model.entities.size);
});

test('display names keep special characters verbatim and label module entities with their file', () => {
  assert.equal(displayName({ name: 'C.get x', file: 'src/a.ts' }), 'C.get x');
  assert.equal(displayName({ name: 'a%2Eb', file: 'src/a.ts' }), 'a%2Eb');
  assert.equal(displayName({ name: '<module>', file: 'src/utils/math.ts' }), '<module> (math.ts)');
});

test('2.0 evidence behavior is unchanged', () => {
  const evidence = load();
  evidence.schemaVersion = '2.0';
  const model = prepareData(input(evidence));
  assert.equal(model.schemaVersion, '2.0');
  assert.throws(() => prepareData({ ...input(evidence), graph: { ...evidence.technicalGraph, schemaVersion: '2.0' } }), /Unsupported technical graph/);
});
