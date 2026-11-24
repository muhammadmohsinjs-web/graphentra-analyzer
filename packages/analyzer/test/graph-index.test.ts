import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGraphIndex, findSurfacesForEntity, type Entity, type Relation, type Surface } from '../src/index';

const entity = (id: string, startLine: number): Entity => {
  const [file, name] = id.split('#') as [string, string];
  return { id, kind: 'function', name, file, startLine, endLine: startLine + 2 };
};
const rel = (from: string, to: string, type: Relation['type'] = 'CALLS'): Relation => ({ from, to, type });
const surface = (id: string, entryEntityIds: string[]): Surface => ({
  id, kind: 'ui_route', route: `/${id}`, source: 'filesystem' as Surface['source'], file: 'app.tsx', line: 1,
  entryEntityIds, access: [], uiText: [], textKeys: [], navigation: [],
});

// a.ts#late is listed before a.ts#early; b.ts#x and b.ts#y share consumer c.ts#page; c.ts#page is reached from a surface.
const entities = [entity('a.ts#late', 30), entity('b.ts#x', 1), entity('a.ts#early', 3), entity('b.ts#y', 9), entity('c.ts#page', 1), entity('c.ts#other', 8)];
const relations = [
  rel('c.ts#page', 'b.ts#x'), rel('c.ts#page', 'b.ts#y', 'RENDERS'), rel('c.ts#other', 'b.ts#x'),
  rel('c.ts#page', 'b.ts#x'), rel('b.ts#x', 'b.ts#y'), rel('a.ts#early', 'a.ts#late', 'REFERENCES'),
];

test('entities by ID and by file, files in first-listed order', () => {
  const index = buildGraphIndex({ entities, relations });
  assert.equal(index.entity('b.ts#y')?.startLine, 9);
  assert.equal(index.entity('missing'), undefined);
  assert.deepEqual(index.entitiesInFile('a.ts').map(e => e.id), ['a.ts#early', 'a.ts#late']);
  assert.deepEqual(index.entitiesInFile('none.ts'), []);
  assert.deepEqual(index.files(), ['a.ts', 'b.ts', 'c.ts']);
});

test('relations in both directions keep input order and filter by type', () => {
  const index = buildGraphIndex({ entities, relations });
  assert.deepEqual(index.incoming('b.ts#x').map(r => r.from), ['c.ts#page', 'c.ts#other', 'c.ts#page']);
  assert.deepEqual(index.outgoing('c.ts#page').map(r => `${r.to}:${r.type}`), ['b.ts#x:CALLS', 'b.ts#y:RENDERS', 'b.ts#x:CALLS']);
  assert.deepEqual(index.incoming('b.ts#y', ['RENDERS']).map(r => r.from), ['c.ts#page']);
  assert.deepEqual(index.outgoing('a.ts#early', ['CALLS']), []);
  assert.deepEqual(index.incoming('nobody'), []);
  // Distinct callers, so the duplicate c.ts#page -> b.ts#x counts once.
  assert.equal(index.callerCount('b.ts#x'), 2);
  assert.equal(index.callerCount('c.ts#page'), 0);
});

test('consumers of a group: sorted, deduplicated, with optional member and type filters', () => {
  const index = buildGraphIndex({ entities, relations });
  assert.deepEqual([...index.consumers(['b.ts#y', 'b.ts#x'])], [
    ['b.ts#x', ['b.ts#y']],
    ['c.ts#other', ['b.ts#x']],
    ['c.ts#page', ['b.ts#y', 'b.ts#x']],
  ]);
  assert.deepEqual([...index.consumers(['b.ts#x', 'b.ts#y'], { excludeMembers: true }).keys()], ['c.ts#other', 'c.ts#page']);
  assert.deepEqual([...index.consumers(['b.ts#x', 'b.ts#y'], { types: ['RENDERS'] })], [['c.ts#page', ['b.ts#y']]]);
  assert.equal(index.consumers([]).size, 0);
});

test('surface lookup walks graph then map relations and matches findSurfacesForEntity', () => {
  const map = {
    surfaces: [surface('home', ['c.ts#page']), surface('admin', ['shell.tsx#Admin'])],
    relations: [{ from: 'shell.tsx#Admin', to: 'c.ts#other', type: 'RENDERS' as const }],
  };
  const index = buildGraphIndex({ entities, relations, applicationMap: map });
  assert.equal(index.applicationMap, map);
  assert.equal(index.surface('admin')?.route, '/admin');
  assert.deepEqual(index.surfacesEnteredAt('c.ts#page').map(s => s.id), ['home']);
  const found = index.surfacesForEntity('b.ts#x').map(item => [item.surface.id, item.path]);
  assert.deepEqual(found, [['home', ['c.ts#page', 'b.ts#x']], ['admin', ['shell.tsx#Admin', 'c.ts#other', 'b.ts#x']]]);
  assert.deepEqual(index.surfacesForEntity('b.ts#x', 1).map(item => item.surface.id), ['home']);
  const fullMap = { ...map, schemaVersion: '1.0' } as unknown as Parameters<typeof findSurfacesForEntity>[0];
  for (const e of entities) {
    assert.deepEqual(findSurfacesForEntity(fullMap, relations, e.id), index.surfacesForEntity(e.id), e.id);
  }
  // Without a map there are no surfaces, and the graph relations still index.
  const bare = buildGraphIndex({ relations });
  assert.deepEqual(bare.surfacesForEntity('b.ts#x'), []);
  assert.equal(bare.entity('b.ts#x'), undefined);
  assert.equal(bare.callerCount('b.ts#x'), 2);
});
