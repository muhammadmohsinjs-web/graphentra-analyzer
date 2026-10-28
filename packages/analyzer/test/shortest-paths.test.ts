import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedEntity, Entity, Relation } from '../src/contracts';
import { MAX_AFFECTED_ENTITIES } from '../src/contracts';
import { buildImpact, getBlastRadiusPaths, getBlastRadiusShortestPaths } from '../src/impact';

type Edge = [caller: string, callee: string];

function makeGraph(nodes: string[], edges: Edge[]) {
  const entityById = new Map<string, Entity>(nodes.map(id => [id, {
    id, kind: 'function', name: id.split('#')[1], file: id.split('#')[0], startLine: 1, endLine: 1,
  } as Entity]));
  const relations: Relation[] = edges.map(([from, to]) => ({ from, to, type: 'CALLS' }));
  return { entityById, relations, reverseAdjacency: reverseOf(relations) };
}

function reverseOf(relations: Relation[]): Map<string, Relation[]> {
  const map = new Map<string, Relation[]>();
  for (const relation of relations) {
    const list = map.get(relation.to) ?? [];
    list.push(relation);
    map.set(relation.to, list);
  }
  return map;
}

function changed(graph: ReturnType<typeof makeGraph>, id: string): ChangedEntity {
  return {
    entity: graph.entityById.get(id)!,
    change: { file: id.split('#')[0], changedLines: [1], addedCode: [], removedCode: [], diff: '' },
  };
}

/** Seeded LCG so generated graphs are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomDag(seed: number, size: number): { nodes: string[]; edges: Edge[] } {
  const random = rng(seed);
  const nodes = Array.from({ length: size }, (_, index) => `f.ts#n${String(index).padStart(2, '0')}`);
  const edges: Edge[] = [];
  // Node i may be called by any node j > i, which keeps the graph acyclic.
  for (let callee = 0; callee < size; callee++) {
    for (let caller = callee + 1; caller < size; caller++) {
      if (random() < 0.25) edges.push([nodes[caller], nodes[callee]]);
    }
  }
  return { nodes, edges };
}

function minLegacyDepths(graph: ReturnType<typeof makeGraph>, start: string): Map<string, number> {
  const minDepth = new Map<string, number>();
  for (const path of getBlastRadiusPaths(start, graph.reverseAdjacency, graph.entityById)) {
    const previous = minDepth.get(path.target.id);
    if (previous === undefined || path.depth < previous) minDepth.set(path.target.id, path.depth);
  }
  return minDepth;
}

test('shortest paths affect the same entities at the same minimal depth as exhaustive enumeration', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { nodes, edges } = randomDag(seed, 9);
    const graph = makeGraph(nodes, edges);
    for (const start of nodes) {
      const legacy = minLegacyDepths(graph, start);
      const shortest = getBlastRadiusShortestPaths(start, graph.reverseAdjacency, graph.entityById);
      assert.equal(shortest.truncated, false);
      const depths = new Map(shortest.paths.map(path => [path.target.id, path.depth]));
      assert.deepEqual([...depths].sort(), [...legacy].sort(), `seed ${seed}, start ${start}`);
      for (const path of shortest.paths) {
        assert.equal(path.depth, path.path.length - 1);
        assert.equal(path.path[0].id, start);
        assert.equal(path.path.at(-1)!.id, path.target.id);
      }
    }
  }
});

test('shortest-path output does not depend on relation order', () => {
  const { nodes, edges } = randomDag(7, 10);
  const graph = makeGraph(nodes, edges);
  const shuffled = makeGraph(nodes, [...edges].reverse());
  for (const start of nodes) {
    const first = buildImpact(changed(graph, start), graph.reverseAdjacency, graph.entityById, undefined, 'extended');
    const second = buildImpact(changed(shuffled, start), shuffled.reverseAdjacency, shuffled.entityById, undefined, 'extended');
    assert.deepEqual(second, first);
  }
});

test('pathCount counts distinct shortest paths and the parent is the lowest-ID predecessor', () => {
  // T calls A and B; both call S. Two shortest paths reach T.
  const graph = makeGraph(
    ['f.ts#S', 'f.ts#A', 'f.ts#B', 'f.ts#T'],
    [['f.ts#A', 'f.ts#S'], ['f.ts#B', 'f.ts#S'], ['f.ts#T', 'f.ts#A'], ['f.ts#T', 'f.ts#B']],
  );
  const impact = buildImpact(changed(graph, 'f.ts#S'), graph.reverseAdjacency, graph.entityById, undefined, 'extended');
  const toT = impact.blastRadius.paths.find(path => path.target.id === 'f.ts#T')!;
  assert.equal(toT.pathCount, 2);
  assert.deepEqual(toT.path.map(entity => entity.id), ['f.ts#S', 'f.ts#A', 'f.ts#T']);
  assert.equal(impact.blastRadius.truncated, false);
});

test('legacy engine keeps exhaustive paths and reports no extended fields', () => {
  const graph = makeGraph(
    ['f.ts#S', 'f.ts#A', 'f.ts#B', 'f.ts#T'],
    [['f.ts#A', 'f.ts#S'], ['f.ts#B', 'f.ts#S'], ['f.ts#T', 'f.ts#A'], ['f.ts#T', 'f.ts#B']],
  );
  const impact = buildImpact(changed(graph, 'f.ts#S'), graph.reverseAdjacency, graph.entityById, undefined, 'legacy');
  const toT = impact.blastRadius.paths.filter(path => path.target.id === 'f.ts#T');
  assert.equal(toT.length, 2);
  assert.ok(toT.every(path => path.pathCount === undefined));
  assert.equal('truncated' in impact.blastRadius, false);
});

test('hub with more affected entities than the cap is truncated deterministically and quickly', () => {
  // S has 2,500 direct callers; each direct caller has its own caller, so 5,000 entities are affected.
  const direct = Array.from({ length: 2500 }, (_, index) => `f.ts#C${String(index).padStart(4, '0')}`);
  const outer = direct.map((id, index) => `f.ts#D${String(index).padStart(4, '0')}`);
  const nodes = ['f.ts#S', ...direct, ...outer];
  const edges: Edge[] = [];
  for (let index = 0; index < direct.length; index++) {
    edges.push([direct[index], 'f.ts#S'], [outer[index], direct[index]]);
  }
  const graph = makeGraph(nodes, edges);
  const started = performance.now();
  const impact = buildImpact(changed(graph, 'f.ts#S'), graph.reverseAdjacency, graph.entityById, undefined, 'extended');
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  assert.equal(impact.blastRadius.truncated, true);
  assert.equal(impact.blastRadius.paths.length, MAX_AFFECTED_ENTITIES);
  assert.equal(impact.blastRadius.totalAffectedEntities, MAX_AFFECTED_ENTITIES);
  // Shallowest first: every kept entity is a direct caller, and the lowest IDs are kept.
  assert.ok(impact.blastRadius.paths.every(path => path.depth === 1));
  assert.deepEqual(impact.blastRadius.paths.map(path => path.target.id).sort(), direct.slice(0, MAX_AFFECTED_ENTITIES));
});
