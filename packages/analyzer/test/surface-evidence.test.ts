import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  analyzeRepository, buildSurfaceEvidence, type ApplicationMap, type FrameworkDetection, type Surface, type SurfaceProvenance,
} from '../src/index';
import { normalizeNextRoute, normalizeNextSegment, segmentsToRoute } from '../src/adapters/nextjs-files';
import { routeMatches } from '../src/application-map-ast';
import { createRepo } from './helpers/git-fixture';

function surface(id: string, entry: string[], extra: Partial<Surface> = {}): Surface {
  const api = id.startsWith('api:');
  return {
    id, kind: api ? 'api_endpoint' : 'ui_route', route: api ? id.split(' ')[1]! : id.slice(3), ...(api ? { method: id.slice(4).split(' ')[0]! } : {}),
    source: api ? 'next-route-handler' : 'next-app-router', file: 'app/x.tsx', line: 3, entryEntityIds: entry,
    access: [{ kind: 'guard', value: 'G', file: 'a', line: 1 }], uiText: ['Hello'], textKeys: ['k'], navigation: ['/'], ...extra,
  };
}

function mapOf(surfaces: Surface[]): ApplicationMap {
  return { schemaVersion: '1.0', analyzerVersion: '0', headSha: 'h', platform: { frontend: true, backend: true, frameworks: [] },
    surfaces, navigation: [], requests: [], e2eFlows: [], relations: [], entityFingerprints: {}, limitations: [] };
}

const next = (major: number | undefined, certified: boolean): FrameworkDetection => ({
  framework: 'next', declared: major === undefined ? 'canary' : `${major}.0.0`, ...(major === undefined ? {} : { resolved: `${major}.1.0`, major }),
  source: major === undefined ? 'package.json' : 'lockfile', certified,
});

const provenance = (ids: Record<string, string>): SurfaceProvenance =>
  new Map(Object.entries(ids).map(([id, adapterId]) => [id, { adapterId, adapterVersion: '1.0.0' }]));

test('buildSurfaceEvidence projects map surfaces into sorted evidence with SURFACE_HANDLED_BY edges and adapters', () => {
  const map = mapOf([surface('ui:/b', ['b#Page', 'z#Gone', 'a#Wrap']), surface('api:GET /a', ['a#get'])]);
  const built = buildSurfaceEvidence({ map, provenance: provenance({ 'ui:/b': 'nextjs-app-router', 'api:GET /a': 'nextjs-route-handler' }),
    frameworkVersions: [next(14, true)], entityIds: new Set(['a#Wrap', 'a#get', 'b#Page']) });
  assert.deepEqual(built.surfaces.map(s => s.id), ['api:GET /a', 'ui:/b']);
  const ui = built.surfaces[1]!;
  assert.deepEqual(ui, { id: 'ui:/b', kind: 'ui_route', route: '/b', file: 'app/x.tsx', line: 3, handlerEntityIds: ['a#Wrap', 'b#Page'],
    framework: 'nextjs@14', adapter: { id: 'nextjs-app-router', version: '1.0.0' }, confidence: 'proven', source: 'detected' });
  assert.equal(built.surfaces[0]!.method, 'GET');
  assert.deepEqual(built.surfaceEdges.map(e => `${e.from}|${e.type}|${e.to}|${e.confidence}`), [
    'api:GET /a|SURFACE_HANDLED_BY|a#get|proven', 'ui:/b|SURFACE_HANDLED_BY|a#Wrap|proven', 'ui:/b|SURFACE_HANDLED_BY|b#Page|proven',
  ]);
  assert.deepEqual(built.adapters, [
    { id: 'nextjs-app-router', version: '1.0.0', framework: 'next', detectedVersion: '14.1.0', certified: true },
    { id: 'nextjs-route-handler', version: '1.0.0', framework: 'next', detectedVersion: '14.1.0', certified: true },
  ]);
  assert.deepEqual(built.diagnostics, []);
});

test('D11: uncertified or unknown major makes surfaces likely with one diagnostic per adapter', () => {
  const map = mapOf([surface('ui:/a', ['a#A']), surface('ui:/b', ['b#B'])]);
  for (const detection of [next(16, false), next(undefined, false)]) {
    const built = buildSurfaceEvidence({ map, provenance: provenance({ 'ui:/a': 'nextjs-app-router', 'ui:/b': 'nextjs-app-router' }),
      frameworkVersions: [detection], entityIds: new Set(['a#A', 'b#B']) });
    assert.ok(built.surfaces.every(s => s.confidence === 'likely'));
    assert.ok(built.surfaceEdges.every(e => e.confidence === 'likely'));
    assert.deepEqual(built.diagnostics.map(d => `${d.code}|${d.severity}`), ['FRAMEWORK_VERSION_NOT_CERTIFIED|info']);
    assert.equal(built.adapters[0]!.certified, false);
    assert.equal(built.surfaces[0]!.framework, detection.major === undefined ? undefined : 'nextjs@16');
  }
});

test('D11: a dependency-gated adapter with no detected framework version is likely, with one diagnostic', () => {
  const built = buildSurfaceEvidence({ map: mapOf([surface('ui:/a', ['a#A']), surface('api:GET /b', ['b#B'])]),
    provenance: provenance({ 'ui:/a': 'nextjs-app-router', 'api:GET /b': 'nextjs-route-handler' }), frameworkVersions: [], entityIds: new Set(['a#A', 'b#B']) });
  assert.ok(built.surfaces.every(s => s.confidence === 'likely'));
  assert.ok(built.surfaceEdges.every(e => e.confidence === 'likely'));
  assert.deepEqual(built.diagnostics.map(d => `${d.code}|${d.severity}`), ['FRAMEWORK_VERSION_NOT_CERTIFIED|info', 'FRAMEWORK_VERSION_NOT_CERTIFIED|info']);
  assert.ok(built.adapters.every(a => a.certified === false && a.framework === undefined));
});

test('surfaces of an adapter without a detected framework stay proven and uncertified, without diagnostics', () => {
  const built = buildSurfaceEvidence({ map: mapOf([surface('ui:/a', ['a#A'])]), provenance: provenance({ 'ui:/a': 'route-config' }),
    frameworkVersions: [], entityIds: new Set(['a#A']) });
  assert.equal(built.surfaces[0]!.confidence, 'proven');
  assert.equal(built.surfaces[0]!.framework, undefined);
  assert.deepEqual(built.adapters, [{ id: 'route-config', version: '1.0.0', certified: false }]);
  assert.deepEqual(built.diagnostics, []);
});

test('buildSurfaceEvidence is independent of map order', () => {
  const surfaces = [surface('ui:/b', ['b#B']), surface('api:GET /a', ['a#A']), surface('ui:/a', ['a#A'])];
  const args = (list: Surface[]) => ({ map: mapOf(list), provenance: provenance({ 'ui:/b': 'x', 'api:GET /a': 'y', 'ui:/a': 'x' }),
    frameworkVersions: [], entityIds: new Set(['a#A', 'b#B']) });
  assert.deepEqual(buildSurfaceEvidence(args(surfaces)), buildSurfaceEvidence(args([...surfaces].reverse())));
});

test('Next.js dynamic segments: the map keeps [id]; the 3.0 projection uses :param, catch-alls :param*', () => {
  assert.equal(normalizeNextSegment('[id]'), ':id');
  assert.equal(normalizeNextSegment('[...slug]'), ':slug*');
  assert.equal(normalizeNextSegment('[[...slug]]'), ':slug*');
  assert.equal(normalizeNextSegment('static'), 'static');
  assert.equal(segmentsToRoute('(shop)/products/[id]/reviews/[[...rest]]/'), '/products/[id]/reviews/[[...rest]]');
  assert.equal(normalizeNextRoute('/products/[id]/reviews/[[...rest]]'), '/products/:id/reviews/:rest*');

  const map = mapOf([surface('ui:/products/[id]', ['p#Page'], { route: '/products/[id]' }),
    surface('api:GET /api/items/[id]', ['i#GET'], { route: '/api/items/[id]' }),
    surface('ui:/orders/[id]', ['o#O'], { route: '/orders/[id]', source: 'jsx-route' })]);
  const built = buildSurfaceEvidence({ map, provenance: provenance({ 'ui:/products/[id]': 'nextjs-app-router',
    'api:GET /api/items/[id]': 'nextjs-route-handler', 'ui:/orders/[id]': 'react-router' }),
    frameworkVersions: [next(14, true)], entityIds: new Set(['p#Page', 'i#GET', 'o#O']) });
  assert.deepEqual(built.surfaces.map(s => [s.id, s.route]), [
    ['api:GET /api/items/:id', '/api/items/:id'], ['ui:/orders/[id]', '/orders/[id]'], ['ui:/products/:id', '/products/:id']]);
  assert.ok(built.surfaces.every(s => s.confidence === 'proven'));
  assert.deepEqual(built.surfaceEdges.map(e => e.from), ['api:GET /api/items/:id', 'ui:/orders/[id]', 'ui:/products/:id']);
  assert.ok(routeMatches('/products/:id', '/products/42'), 'a concrete URL still matches the 3.0 surface');
  assert.ok(map.surfaces.some(s => s.id === 'ui:/products/[id]'), 'the map is not modified');
});

function repositoryWith(files: Record<string, string>) {
  const repo = createRepo('graphentra-surface-');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, file), content);
  }
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo.dir, 'probe.ts'), 'export const probe = 1;\n');
  return repo;
}

for (const [version, appRouter] of [['12.3.4', false], ['13.5.6', true]] as const) {
  test(`D11: Next.js ${version} ${appRouter ? 'keeps' : 'drops'} app/ surfaces in 3.0; the 2.x map always keeps them`, () => {
    const repo = repositoryWith({
      'package.json': JSON.stringify({ dependencies: { next: version } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', noEmit: true } }),
      'app/shop/page.tsx': 'export default function Shop() { return <h1>Shop</h1>; }\n',
      'app/api/items/route.ts': 'export function GET() { return []; }\n',
      'pages/legacy.tsx': 'export default function Legacy() { return <h1>Legacy</h1>; }\n',
    });
    try {
      const mapIds = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } }).applicationMap.surfaces.map(s => s.id);
      for (const id of ['ui:/legacy', 'ui:/shop', 'api:GET /api/items']) assert.ok(mapIds.includes(id), `map: ${mapIds.join(', ')}`);
      const evidence = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, evidenceSchema: '3.0' }).evidence;
      const ids = evidence.surfaces!.map(s => s.id);
      assert.ok(ids.includes('ui:/legacy'), ids.join(', '));
      assert.equal(ids.includes('ui:/shop'), appRouter, ids.join(', '));
      assert.equal(ids.includes('api:GET /api/items'), appRouter, ids.join(', '));
      assert.equal(evidence.diagnostics.some(d => d.code === 'NEXT_APP_ROUTER_UNSUPPORTED' && d.severity === 'info'), !appRouter);
    } finally { repo.cleanup(); }
  });
}

test('D4/D11: [id] and :id merged into one 3.0 surface take the weaker confidence, independent of order', () => {
  const nextUi = surface('ui:/p/[id]', ['p#Next'], { route: '/p/[id]', file: 'apps/web/app/p/[id]/page.tsx' });
  const rr = surface('ui:/p/:id', ['p#Rr'], { route: '/p/:id', source: 'jsx-route', file: 'apps/spa/routes.tsx' });
  const prov = provenance({ 'ui:/p/[id]': 'nextjs-app-router', 'ui:/p/:id': 'react-router' });
  const versions = (file: string) => (file.startsWith('apps/web/') ? [next(16, false)] : []);
  const results = [[nextUi, rr], [rr, nextUi]].map(list => buildSurfaceEvidence({ map: mapOf(list), provenance: prov, frameworkVersions: [],
    frameworkVersionsFor: versions, entityIds: new Set(['p#Next', 'p#Rr']) }));
  assert.deepEqual(results[0], results[1]);
  const [merged] = results[0]!.surfaces;
  assert.equal(results[0]!.surfaces.length, 1);
  assert.equal(merged!.id, 'ui:/p/:id');
  assert.equal(merged!.confidence, 'likely', 'the uncertified Next.js surface weakens the merged one');
  assert.deepEqual(merged!.handlerEntityIds, ['p#Next', 'p#Rr']);
  assert.ok(results[0]!.surfaceEdges.every(e => e.confidence === 'likely'));
});

test('D11 in a monorepo: each surface uses the version of the package.json that gated it; the 2.x map is unchanged', () => {
  const expressTypes = "declare module 'express' {\n  interface App { get(path: string, handler: (req: unknown, res: unknown) => void): App }\n" +
    '  const express: () => App;\n  export default express;\n}\n';
  const repo = repositoryWith({
    'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', noEmit: true, esModuleInterop: true } }),
    'types.d.ts': expressTypes,
    'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { express: '3.0.0' } }),
    'apps/api/server.ts': "import express from 'express';\nconst app = express();\nexport function listOrders(_req: unknown, _res: unknown) {}\napp.get('/orders', listOrders);\n",
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '12.3.4' } }),
    'apps/web/app/shop/page.tsx': 'export default function Shop() { return <h1>Shop</h1>; }\n',
    'apps/web/pages/legacy.tsx': 'export default function Legacy() { return <h1>Legacy</h1>; }\n',
  });
  try {
    const base = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const mapIds = base.applicationMap.surfaces.map(s => s.id);
    for (const id of ['api:GET /orders', 'ui:/shop', 'ui:/legacy']) assert.ok(mapIds.includes(id), `map: ${mapIds.join(', ')}`);
    const evidence = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, evidenceSchema: '3.0' }).evidence;
    const byId = new Map(evidence.surfaces!.map(s => [s.id, s]));
    assert.equal(byId.get('api:GET /orders')?.confidence, 'likely', [...byId.keys()].join(', '));
    assert.equal(byId.get('api:GET /orders')?.framework, 'express@3');
    assert.equal(byId.has('ui:/shop'), false, 'next 12 in apps/web: app/ is not a router');
    assert.equal(byId.get('ui:/legacy')?.confidence, 'likely', 'next 12 is not a certified major');
    const express = evidence.adapters!.find(a => a.id === 'express-declarative');
    assert.deepEqual(express && { framework: express.framework, detectedVersion: express.detectedVersion, certified: express.certified },
      { framework: 'express', detectedVersion: '3.0.0', certified: false });
    const diagnostics = evidence.diagnostics.filter(d => d.code === 'FRAMEWORK_VERSION_NOT_CERTIFIED' || d.code === 'NEXT_APP_ROUTER_UNSUPPORTED');
    assert.ok(diagnostics.some(d => d.code === 'FRAMEWORK_VERSION_NOT_CERTIFIED' && /express-declarative ran on express 3\.0\.0/.test(d.message)),
      diagnostics.map(d => d.message).join('\n'));
    assert.ok(diagnostics.some(d => d.code === 'NEXT_APP_ROUTER_UNSUPPORTED' && /Next\.js 12\.3\.4/.test(d.message) && /ui:\/shop/.test(d.message)));
    assert.ok(diagnostics.every(d => d.severity === 'info'));
  } finally { repo.cleanup(); }
});
