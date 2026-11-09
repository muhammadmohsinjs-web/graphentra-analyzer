import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  analyzeRepository, buildSurfaceEvidence, type ApplicationMap, type FrameworkDetection, type Surface, type SurfaceProvenance,
} from '../src/index';
import { normalizeNextSegment, segmentsToRoute } from '../src/adapters/nextjs-files';
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

test('Next.js dynamic segments are normalized to :param, catch-alls to :param*', () => {
  assert.equal(normalizeNextSegment('[id]'), ':id');
  assert.equal(normalizeNextSegment('[...slug]'), ':slug*');
  assert.equal(normalizeNextSegment('[[...slug]]'), ':slug*');
  assert.equal(normalizeNextSegment('static'), 'static');
  assert.equal(segmentsToRoute('(shop)/products/[id]/reviews/[[...rest]]/'), '/products/:id/reviews/:rest*');
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
  test(`D11: Next.js ${version} ${appRouter ? 'runs' : 'skips'} app/ router rules`, () => {
    const repo = repositoryWith({
      'package.json': JSON.stringify({ dependencies: { next: version } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', noEmit: true } }),
      'app/shop/page.tsx': 'export default function Shop() { return <h1>Shop</h1>; }\n',
      'app/api/items/route.ts': 'export function GET() { return []; }\n',
      'pages/legacy.tsx': 'export default function Legacy() { return <h1>Legacy</h1>; }\n',
    });
    try {
      const ids = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } }).applicationMap.surfaces.map(s => s.id);
      assert.ok(ids.includes('ui:/legacy'), ids.join(', '));
      assert.equal(ids.includes('ui:/shop'), appRouter, ids.join(', '));
      assert.equal(ids.includes('api:GET /api/items'), appRouter, ids.join(', '));
    } finally { repo.cleanup(); }
  });
}
