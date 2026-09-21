import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareData, buildTraversal, layoutGraph, edgeKey, isTest } from '../public/model.mjs';

function fixture() {
  const entities = ['seed', 'left', 'right', 'shared', 'isolated'].map((name, index) => ({
    id: name, name, kind: 'function', file: `${index < 3 ? 'src/service' : 'tests/service.test'}.ts`, startLine: index * 10 + 1, endLine: index * 10 + 5,
  }));
  const paths = [['seed', 'left'], ['seed', 'right'], ['seed', 'left', 'shared'], ['seed', 'right', 'shared']];
  const entity = id => entities.find(entity => entity.id === id);
  return {
    graph: { schemaVersion: '1.0', repository: { headSha: 'abc' }, capabilities: { maxBlastDepth: 6 }, entities,
      relations: [['left', 'seed'], ['right', 'seed'], ['shared', 'left'], ['shared', 'right'], ['seed', 'shared']].map(([from, to]) => ({ from, to, type: 'CALLS' })) },
    analysis: { schemaVersion: '1.1', repository: { headSha: 'abc' }, changedEntities: [{ entity: entity('seed') }], impacts: [{
      changedEntity: entity('seed'), change: { diff: '-old\n+new' },
      blastRadius: { totalAffectedEntities: 3, entities: ['left', 'right', 'shared'].map(entity), paths: paths.map(path => ({ target: entity(path.at(-1)), depth: path.length - 1, path: path.map(entity) })) },
    }] }, warnings: [],
  };
}

test('recorded traversal follows reverse CALLS, retains alternative paths and deduplicates affected nodes', () => {
  const model = prepareData(fixture());
  const result = buildTraversal(model, ['seed']);
  assert.equal(result.depths.get('seed'), 0);
  assert.equal(result.depths.get('shared'), 2);
  assert.equal(result.depths.size, 4);
  assert.equal(result.paths.get('shared').length, 2);
  assert.equal(result.edges.get(edgeKey('seed', 'left')), 1);
  assert.equal(result.depths.has('isolated'), false);
  assert.equal(result.maxLayer, 2);
});

test('recorded traversal does not invent additional paths from the graph', () => {
  const data = fixture();
  data.graph.relations.push({ from: 'isolated', to: 'seed', type: 'CALLS' });
  assert.equal(buildTraversal(prepareData(data), ['seed']).depths.has('isolated'), false);
  assert.equal(buildTraversal(prepareData(data), ['seed'], true).depths.get('isolated'), 1);
});

test('what-if traversal terminates cycles and respects the depth limit', () => {
  const data = fixture(); data.analysis = null;
  const model = prepareData(data);
  const result = buildTraversal(model, ['seed'], true);
  assert.equal(result.depths.size, 4);
  assert.equal(result.depths.get('seed'), 0);
  assert.equal(result.paths.get('shared').length, 1);
  model.maxDepth = 1;
  const limited = buildTraversal(model, ['seed'], true);
  assert.equal(limited.depths.size, 3);
  assert.equal(limited.maxLayer, 1);
});

test('all changes preserves seed depth zero and deduplicates shared dependents', () => {
  const data = fixture();
  const shared = data.graph.entities.find(entity => entity.id === 'shared');
  const right = data.graph.entities.find(entity => entity.id === 'right');
  data.analysis.changedEntities.push({ entity: right });
  data.analysis.impacts.push({ changedEntity: right, change: { diff: 'change' }, blastRadius: {
    totalAffectedEntities: 1, entities: [shared], paths: [{ target: shared, depth: 1, path: [right, shared] }],
  } });
  const result = buildTraversal(prepareData(data), ['seed', 'right']);
  assert.equal(result.depths.get('right'), 0);
  assert.equal(result.depths.get('shared'), 1);
  assert.equal([...result.depths.keys()].filter(id => !result.seeds.has(id)).length, 2);
});

test('incompatible, malformed, and mismatched saved analysis is ignored with a warning', () => {
  for (const mutate of [
    data => { data.analysis.repository.headSha = 'different'; },
    data => { data.analysis.impacts[0].blastRadius.paths[0].path.reverse(); },
    data => { data.analysis.impacts[0].blastRadius.totalAffectedEntities = 12; },
    data => { data.analysis.impacts[0].blastRadius.paths[0].depth = 6; },
    data => { data.analysis.changedEntities = []; },
    data => { data.analysis.impacts[0].change = null; },
  ]) {
    const data = fixture(); mutate(data);
    const model = prepareData(data);
    assert.equal(model.analysis, null);
    assert.match(model.warnings.at(-1), /ignored/);
  }
});

test('invalid graph identities and dangling edges fail clearly', () => {
  const duplicate = fixture(); duplicate.graph.entities.push(duplicate.graph.entities[0]);
  assert.throws(() => prepareData(duplicate), /duplicate/);
  const dangling = fixture(); dangling.graph.relations[0].to = 'missing';
  assert.throws(() => prepareData(dangling), /invalid CALLS/);
});

test('empty graph and disconnected seeds are valid', () => {
  const data = fixture(); data.analysis = null;
  assert.equal(buildTraversal(prepareData(data), ['isolated'], true).maxLayer, 0);
  data.graph.entities = []; data.graph.relations = [];
  const model = prepareData(data);
  assert.equal(buildTraversal(model, [], true).maxLayer, 0);
  assert.equal(layoutGraph(model.entities).positions.size, 0);
});

test('file layout is stable independent of entity input order and has no overlapping groups', () => {
  const model = prepareData(fixture());
  const layout = layoutGraph(model.entities);
  assert.deepEqual(layoutGraph(new Map([...model.entities].reverse())), layout);
  assert.equal(layout.positions.size, model.entities.size);
  for (const group of layout.groups) {
    for (const entity of group.members) {
      const position = layout.positions.get(entity.id);
      assert.ok(position.x > group.x && position.x + position.width < group.x + group.width);
      assert.ok(position.y > group.y && position.y + position.height < group.y + group.height);
    }
  }
});

test('test roles follow the analyzer filename heuristics', () => {
  for (const file of ['tests/orders.ts', 'src/__tests__/order.ts', 'src/order.spec.tsx', 'src\\tests\\order.ts']) assert.ok(isTest(file));
  for (const file of ['src/order.ts', 'src/testable.ts']) assert.equal(isTest(file), false);
});
