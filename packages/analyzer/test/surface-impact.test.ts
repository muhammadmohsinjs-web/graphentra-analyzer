import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_SURFACE_REACH_DEPTH, computeAffectedSurfaces, withAffectedSurfaces, type EdgeConfidence, type EntityImpact, type Relation, type SurfaceEdge,
} from '../src/index';

const call = (from: string, to: string, confidence?: EdgeConfidence): Relation => ({ from, to, type: 'CALLS', ...(confidence ? { confidence } : {}) });
const handled = (from: string, to: string, confidence: EdgeConfidence = 'proven'): SurfaceEdge => ({ from, to, type: 'SURFACE_HANDLED_BY', confidence });
const calls = (from: string, to: string, confidence: EdgeConfidence = 'proven'): SurfaceEdge => ({ from, to, type: 'CALLS_ENDPOINT', confidence });

test('D7: reaches a page through its api endpoint and the client that calls it', () => {
  const affected = computeAffectedSurfaces({
    entityId: 'db#query',
    relations: [call('api#list', 'db#query'), call('page#Home', 'client#fetch')],
    surfaceEdges: [handled('api:GET /users', 'api#list'), calls('client#fetch', 'api:GET /users', 'likely'), handled('ui:/', 'page#Home')],
    surfaceIds: ['api:GET /users', 'ui:/'],
  });
  assert.deepEqual(affected, [
    { surfaceId: 'api:GET /users', depth: 2, path: ['db#query', 'api#list', 'api:GET /users'], confidence: 'proven' },
    { surfaceId: 'ui:/', depth: 5, path: ['db#query', 'api#list', 'api:GET /users', 'client#fetch', 'page#Home', 'ui:/'], confidence: 'likely' },
  ]);
});

test('path confidence is the weakest edge, and a proven path wins among equally short ones', () => {
  const base = { entityId: 'x', surfaceIds: ['ui:/'], surfaceEdges: [handled('ui:/', 'page')] };
  assert.equal(computeAffectedSurfaces({ ...base, relations: [call('page', 'x', 'likely')] })[0]!.confidence, 'likely');
  const both = computeAffectedSurfaces({ ...base, relations: [call('a', 'x', 'likely'), call('page', 'a'), call('b', 'x'), call('page', 'b')] });
  assert.deepEqual(both, [{ surfaceId: 'ui:/', depth: 3, path: ['x', 'b', 'page', 'ui:/'], confidence: 'proven' }]);
});

test('results are sorted by depth then surfaceId and independent of input order', () => {
  const relations = [call('h1', 'x'), call('h2', 'x'), call('h3', 'h1')];
  const surfaceEdges = [handled('ui:/b', 'h1'), handled('ui:/a', 'h2'), handled('api:GET /c', 'h3'), { from: 't', to: 'h1', type: 'TEST_COVERS', confidence: 'proven' } as SurfaceEdge];
  const surfaceIds = ['ui:/a', 'ui:/b', 'api:GET /c'];
  const forward = computeAffectedSurfaces({ entityId: 'x', relations, surfaceEdges, surfaceIds });
  const backward = computeAffectedSurfaces({ entityId: 'x', relations: [...relations].reverse(), surfaceEdges: [...surfaceEdges].reverse(), surfaceIds: [...surfaceIds].reverse() });
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.map(item => `${item.depth}:${item.surfaceId}`), ['2:ui:/a', '2:ui:/b', '3:api:GET /c']);
  assert.ok(!forward.some(item => item.path.includes('t')), 'TEST_COVERS is not traversed');
});

test('depth limit is MAX_SURFACE_REACH_DEPTH edges and cycles terminate', () => {
  assert.equal(MAX_SURFACE_REACH_DEPTH, 10);
  const chain = (length: number) => {
    const relations: Relation[] = [];
    for (let i = 1; i < length; i += 1) relations.push(call(`n${i}`, `n${i - 1}`));
    relations.push(call('n0', `n${length - 1}`));
    return { entityId: 'n0', relations, surfaceEdges: [handled('ui:/end', `n${length - 1}`)], surfaceIds: ['ui:/end'] };
  };
  assert.equal(computeAffectedSurfaces(chain(10))[0]!.depth, 10);
  assert.deepEqual(computeAffectedSurfaces(chain(11)), []);
  assert.equal(computeAffectedSurfaces({ ...chain(11), maxDepth: 11 })[0]!.depth, 11);
});

test('withAffectedSurfaces leaves the field absent when nothing is reached', () => {
  const impact = (id: string) => ({ changedEntity: { id } }) as unknown as EntityImpact;
  const [reached, none] = withAffectedSurfaces([impact('h'), impact('lonely')], {
    relations: [], surfaceEdges: [handled('ui:/', 'h')], surfaceIds: ['ui:/'] });
  assert.deepEqual(reached!.affectedSurfaces, [{ surfaceId: 'ui:/', depth: 1, path: ['h', 'ui:/'], confidence: 'proven' }]);
  assert.ok(!('affectedSurfaces' in none!));
});
