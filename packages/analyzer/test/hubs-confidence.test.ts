import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliOptions } from '../src/cli-options';
import type { ChangedEntity, Entity, Relation } from '../src/contracts';
import { buildImpact } from '../src/impact';

const entity = (id: string): Entity => ({ id, name: id, file: `${id}.ts`, startLine: 1, endLine: 2 } as Entity);
const call = (from: string, to: string, confidence?: 'likely'): Relation =>
  ({ from, to, type: 'calls', ...(confidence ? { confidence } : {}) } as Relation);

function graph(relations: Relation[]) {
  const entityById = new Map<string, Entity>();
  const reverse = new Map<string, Relation[]>();
  for (const relation of relations) {
    for (const id of [relation.from, relation.to]) if (!entityById.has(id)) entityById.set(id, entity(id));
    reverse.set(relation.to, [...(reverse.get(relation.to) ?? []), relation]);
  }
  return { entityById, reverse };
}
const changed = (g: ReturnType<typeof graph>, id: string): ChangedEntity => ({ entity: g.entityById.get(id)!, change: {} as never });
const impact = (relations: Relation[], id: string, ...rest: [number?, number?, number?]) => {
  const g = graph(relations);
  return buildImpact(changed(g, id), g.reverse, g.entityById, rest[0], 'extended', rest[1], rest[2]);
};

/** hub has `callers` callers c00.., each called by its own caller g00.. */
function hubGraph(callers = 30): Relation[] {
  const relations: Relation[] = [];
  for (let i = 0; i < callers; i++) {
    const n = String(i).padStart(2, '0');
    relations.push(call(`c${n}`, 'hub'), call(`g${n}`, `c${n}`));
  }
  return relations;
}

test('a hub is recorded and not expanded', () => {
  const result = impact(hubGraph(), 'hub');
  assert.equal(result.blastRadius.totalAffectedEntities, 30);
  assert.ok(result.blastRadius.paths.every(path => path.depth === 1));
  assert.equal(result.blastRadius.truncated, true);
  assert.equal(result.blastRadius.hubs?.length, 1);
  assert.equal(result.blastRadius.hubs![0].entityId, 'hub');
  assert.equal(result.blastRadius.hubs![0].fanIn, 30);
});

test('reach counts nodes reachable within the remaining depth, capped by maxAffected', () => {
  assert.equal(impact(hubGraph(), 'hub').blastRadius.hubs![0].reach, 60);
  assert.equal(impact(hubGraph(), 'hub', 1).blastRadius.hubs![0].reach, 30);
  assert.equal(impact(hubGraph(), 'hub', undefined, 40).blastRadius.hubs![0].reach, 40);
});

test('a hub reached mid-traversal keeps its dependents but stops there', () => {
  const relations = [...hubGraph(), call('hub', 'leaf')];
  const result = impact(relations, 'leaf');
  assert.equal(result.blastRadius.paths.find(path => path.target.id === 'hub')?.depth, 1);
  assert.equal(result.blastRadius.totalAffectedEntities, 31);
  assert.deepEqual(result.blastRadius.hubs, [{ entityId: 'hub', fanIn: 30, reach: 60 }]);
  assert.equal(result.blastRadius.truncated, true);
});

test('hubThreshold overrides the default', () => {
  const small = [call('a', 'x'), call('b', 'x'), call('c', 'x'), call('d', 'a')];
  const normal = impact(small, 'x');
  assert.equal(normal.blastRadius.hubs, undefined);
  assert.equal(normal.blastRadius.truncated, false);
  assert.equal(normal.blastRadius.totalAffectedEntities, 4);
  const lowered = impact(small, 'x', undefined, undefined, 3);
  assert.equal(lowered.blastRadius.totalAffectedEntities, 3);
  assert.deepEqual(lowered.blastRadius.hubs, [{ entityId: 'x', fanIn: 3, reach: 4 }]);
  assert.equal(lowered.blastRadius.truncated, true);
  assert.equal(impact(hubGraph(), 'hub', undefined, undefined, 31).blastRadius.totalAffectedEntities, 60);
});

test('maxDepth is configurable', () => {
  const chain = [call('b', 'a'), call('c', 'b'), call('d', 'c')];
  assert.equal(impact(chain, 'a', 2).blastRadius.totalAffectedEntities, 2);
  assert.equal(impact(chain, 'a').blastRadius.totalAffectedEntities, 3);
});

test('a path with one likely edge is likely; the impact takes the weakest path', () => {
  const result = impact([call('b', 'a'), call('c', 'b', 'likely'), call('d', 'a')], 'a');
  const byTarget = new Map(result.blastRadius.paths.map(path => [path.target.id, path.confidence]));
  assert.deepEqual([...byTarget], [['b', 'proven'], ['d', 'proven'], ['c', 'likely']]);
  assert.equal(result.confidence, 'likely');
});

test('a parallel proven and likely pair counts as proven', () => {
  const result = impact([call('b', 'a', 'likely'), { from: 'b', to: 'a', type: 'references' } as Relation], 'a');
  assert.equal(result.blastRadius.paths[0].confidence, 'proven');
  assert.equal(result.confidence, 'proven');
});

test('an impact without paths is proven', () => {
  assert.equal(impact([call('b', 'a')], 'b').confidence, 'proven');
});

test('output is deterministic regardless of relation order', () => {
  const relations = [...hubGraph(), call('hub', 'leaf'), call('hub2', 'leaf')];
  const forward = impact(relations, 'leaf');
  const backward = impact([...relations].reverse(), 'leaf');
  const ids = (value: typeof forward) => value.blastRadius.paths.map(path => `${path.path.map(e => e.id).join('>')}:${path.confidence}`);
  assert.deepEqual(ids(backward), ids(forward));
  assert.deepEqual(backward.blastRadius.hubs, forward.blastRadius.hubs);
});

test('legacy engine output has no confidence or hubs', () => {
  const g = graph(hubGraph());
  const legacy = buildImpact(changed(g, 'hub'), g.reverse, g.entityById, undefined, 'legacy');
  assert.equal(legacy.confidence, undefined);
  assert.equal(legacy.blastRadius.hubs, undefined);
  assert.equal(legacy.blastRadius.paths[0].confidence, undefined);
});

test('--max-depth, --max-affected and --hub-threshold parse positive integers', () => {
  const parsed = parseCliOptions(['/workspace/app', '--max-depth', '3', '--max-affected=50', '--hub-threshold', '10']);
  assert.equal(parsed.maxDepth, 3);
  assert.equal(parsed.maxAffectedEntities, 50);
  assert.equal(parsed.hubThreshold, 10);
  const none = parseCliOptions(['/workspace/app']);
  assert.equal(none.maxDepth, undefined);
  assert.equal(none.hubThreshold, undefined);
  for (const flag of ['max-depth', 'max-affected', 'hub-threshold']) {
    for (const bad of ['0', '-3', '2.5', 'abc']) {
      assert.throws(() => parseCliOptions(['/workspace/app', `--${flag}=${bad}`]), /positive integer/);
    }
    assert.throws(() => parseCliOptions(['/workspace/app', `--${flag}`]), /requires a value/);
  }
  assert.throws(() => parseCliOptions(['/workspace/app', '--max-depth=2', '--max-depth=3']), /only be provided once/);
});
