import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  analyzeRepository, collectBusinessSignals, computeDeterministicEvidenceIdentity, findSurfacesForEntity,
  listProjectFiles, routeMatches,
} from '../src/index';
import { createRepo } from './helpers/git-fixture';

const fixtureRoot = path.resolve(__dirname, 'fixtures/web-app');

function copyFixture(target: string, source: string, relative = ''): void {
  for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(path.join(target, child), { recursive: true }); copyFixture(target, source, child); }
    else fs.copyFileSync(path.join(source, child), path.join(target, child));
  }
}

function webAppRepository() {
  const repo = createRepo('graphentra-appmap-');
  copyFixture(repo.dir, fixtureRoot);
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'initial']);
  const service = path.join(repo.dir, 'src/server/orderService.ts');
  fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace('amount < MIN_ORDER_AMOUNT', 'amount <= MIN_ORDER_AMOUNT'));
  return repo;
}

function repositoryWith(files: Record<string, string>) {
  const repo = createRepo('graphentra-appmap-');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, file), content);
  }
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'initial']);
  return repo;
}

test('application map discovers UI routes, API endpoints, guards, navigation, and client requests', () => {
  const repo = webAppRepository();
  try {
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const map = result.applicationMap;
    assert.deepEqual(map.surfaces.map(surface => surface.id), [
      'api:GET /api/orders/:id', 'api:POST /api/orders', 'ui:/cart', 'ui:/checkout', 'ui:/orders',
    ]);
    const byId = new Map(map.surfaces.map(surface => [surface.id, surface]));
    assert.deepEqual(byId.get('api:POST /api/orders')!.entryEntityIds, ['src/server/orderService.ts#createOrder']);
    assert.ok(byId.get('api:POST /api/orders')!.access.some(hint => hint.value === 'requireAuth'));
    assert.ok(byId.get('ui:/checkout')!.access.some(hint => hint.value === 'RequireAuth'));
    assert.deepEqual(byId.get('ui:/checkout')!.uiText.slice(0, 2), ['Checkout', 'Place order']);
    assert.deepEqual(byId.get('ui:/checkout')!.navigation, [
      "Use the application's main navigation and select 'Your cart'",
      "Select 'Proceed to checkout'",
    ]);
    assert.match(byId.get('ui:/orders')!.navigation.at(-1)!, /Complete 'Place order', which continues to \/orders/);
    const request = map.requests.find(item => item.target === '/api/orders')!;
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.fromSurfaceIds, ['ui:/checkout']);
    assert.deepEqual(request.targetSurfaceIds, ['api:POST /api/orders']);
    assert.deepEqual(map.e2eFlows[0]!.surfaceIds, ['ui:/cart', 'ui:/checkout']);
    assert.equal(map.e2eFlows[0]!.steps[1], "Click the 'Proceed to checkout' link");

    const changed = findSurfacesForEntity(map, result.technicalGraph.relations, 'src/server/orderService.ts#chargeCard');
    assert.deepEqual(changed.map(item => item.surface.id), ['api:POST /api/orders']);
    assert.deepEqual(changed[0]!.path, ['src/server/orderService.ts#createOrder', 'src/server/orderService.ts#chargeCard']);
    const shared = findSurfacesForEntity(map, result.technicalGraph.relations, 'src/shared/pricing.ts#formatPrice');
    assert.deepEqual(shared.map(item => item.surface.id), ['ui:/checkout']);
    assert.ok(map.entityFingerprints['src/server/orderService.ts#chargeCard']);
  } finally { repo.cleanup(); }
});

test('application map is outside the evidence envelope and never changes evidence identity', () => {
  const repo = webAppRepository();
  try {
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.ok(!('applicationMap' in result.evidence));
    const again = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.equal(computeDeterministicEvidenceIdentity(result.evidence), computeDeterministicEvidenceIdentity(again.evidence));
    assert.deepEqual(result.applicationMap, again.applicationMap);
  } finally { repo.cleanup(); }
});

test('business signals collect docs, models, messages, constants, translations, and capability hints', () => {
  const repo = webAppRepository();
  try {
    const comparison = { mode: 'working-tree' as const };
    const result = analyzeRepository({ target: repo.dir, comparison });
    const signals = collectBusinessSignals({ projectRoot: repo.dir, files: listProjectFiles({ target: repo.dir, comparison }), technicalGraph: result.technicalGraph });
    assert.equal(signals.packageInfo.name, 'shopfront');
    assert.ok(signals.packageInfo.capabilityHints.some(hint => hint.hint === 'online payments'));
    assert.deepEqual(signals.documents.map(document => document.path), ['README.md']);
    assert.ok(signals.dataModels.some(model => model.name === 'Order' && model.source === 'prisma'));
    assert.ok(signals.enums.some(item => item.name === 'OrderStatus'));
    assert.ok(signals.messages.some(message => message.text === 'Payment was declined' && message.entityId === 'src/server/orderService.ts#createOrder'));
    assert.ok(signals.constants.some(constant => constant.name === 'MIN_ORDER_AMOUNT' && constant.value === '1'));
    assert.deepEqual(signals.translations[0]!.entries[0], ['nav.catalog', 'Catalog']);
    assert.deepEqual(signals.testTitles.map(item => item.title), ['checkout › customer places an order with a saved card']);
  } finally { repo.cleanup(); }
});

test('Next.js app/pages routing, route config objects, and NestJS controllers become surfaces', () => {
  const repo = repositoryWith({
    'package.json': JSON.stringify({ dependencies: { next: '14.0.0', '@nestjs/core': '10.0.0' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', experimentalDecorators: true, noEmit: true } }),
    'src/app/(shop)/orders/[id]/page.tsx': 'export default function OrderPage() { return <h1>Order details</h1>; }\n',
    'src/app/api/invoices/route.ts': 'export async function GET() { return listInvoices(); }\nexport function listInvoices() { return []; }\n',
    'src/pages/settings/index.tsx': 'export default function Settings() { return <h1>Settings</h1>; }\n',
    'src/admin/routes.ts': [
      'function AdminLayout() { return null; }',
      'function UsersPage() { return null; }',
      'export const routes = [{ path: "/admin", component: AdminLayout, meta: { title: "Back office", roles: ["admin"] },',
      '  children: [{ path: "users", component: UsersPage, canActivate: [AdminGuard] }] }];',
      'declare const AdminGuard: unknown;',
    ].join('\n'),
    'src/billing.controller.ts': [
      'declare function Controller(path?: string): ClassDecorator;',
      'declare function Post(path?: string): MethodDecorator;',
      'declare function UseGuards(...guards: unknown[]): MethodDecorator & ClassDecorator;',
      'declare const JwtGuard: unknown;',
      'export function refund(amount: number) { return amount > 0; }',
      '@Controller("billing")',
      'export class BillingController {',
      '  @UseGuards(JwtGuard)',
      '  @Post("refunds")',
      '  create() { return refund(5); }',
      '}',
    ].join('\n'),
  });
  try {
    fs.appendFileSync(path.join(repo.dir, 'src/billing.controller.ts'), '\n');
    const map = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } }).applicationMap;
    const ids = map.surfaces.map(surface => surface.id);
    for (const id of ['ui:/orders/[id]', 'api:GET /api/invoices', 'ui:/settings', 'ui:/admin', 'ui:/admin/users', 'api:POST /billing/refunds']) {
      assert.ok(ids.includes(id), `${id} missing from ${ids.join(', ')}`);
    }
    const users = map.surfaces.find(surface => surface.id === 'ui:/admin/users')!;
    assert.deepEqual(users.access.map(hint => `${hint.kind}:${hint.value}`), ['role:admin', 'guard:AdminGuard']);
    assert.ok(map.surfaces.find(surface => surface.id === 'ui:/admin')!.uiText.includes('Back office'));
    const refund = map.surfaces.find(surface => surface.id === 'api:POST /billing/refunds')!;
    assert.deepEqual(refund.entryEntityIds, ['src/billing.controller.ts#refund']);
    assert.ok(refund.access.some(hint => hint.value === 'JwtGuard'));
    assert.deepEqual(map.surfaces.find(surface => surface.id === 'api:GET /api/invoices')!.entryEntityIds, ['src/app/api/invoices/route.ts#GET']);
  } finally { repo.cleanup(); }
});

test('route matching handles params, catch-alls, and placeholders', () => {
  assert.ok(routeMatches('/orders/:id', '/orders/42'));
  assert.ok(routeMatches('/orders/[id]', '/orders/:param'));
  assert.ok(routeMatches('/docs/[...slug]', '/docs/a/b'));
  assert.ok(!routeMatches('/orders/:id', '/orders'));
  assert.ok(routeMatches('/', '/'));
});

test('a repository without routing patterns yields an empty but valid application map', () => {
  const repo = repositoryWith({ 'a.ts': 'export function a() { return 1; }\n' });
  try {
    fs.writeFileSync(path.join(repo.dir, 'a.ts'), 'export function a() { return 2; }\n');
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.applicationMap.surfaces, []);
    assert.equal(result.applicationMap.schemaVersion, '1.0');
  } finally { repo.cleanup(); }
});
