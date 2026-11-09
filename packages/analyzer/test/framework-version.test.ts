import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { detectFrameworkVersions, frameworkLabel, nextRouterRules } from '../src/framework-version';

const setup = (files: Record<string, string>, project = '.') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwv-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return { repoRoot: root, projectRoot: path.join(root, project) };
};
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

test('declared-only ranges', () => {
  const cases: Array<[string, number | undefined]> = [
    ['^14.1.0', 14], ['~13', 13], ['14.x', 14], ['>=13 <15', 13], ['*', undefined], ['latest', undefined],
    ['workspace:*', undefined], ['link:../x', undefined], ['file:../x', undefined],
    ['git+https://github.com/a/b.git', undefined], ['github:a/b', undefined],
  ];
  for (const [range, major] of cases) {
    const d = detectFrameworkVersions(setup({ 'package.json': pkg({ next: range }) }));
    assert.equal(d.length, 1);
    assert.equal(d[0].major, major, range);
    assert.equal(d[0].source, 'package.json');
    assert.equal(d[0].resolved, undefined);
  }
});

test('package-lock v3, v2 packages and v1 dependencies', () => {
  const lockV3 = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/next': { version: '14.2.3' } } });
  const lockV1 = JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: '13.5.6' } } });
  const a = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '^14.0.0' }), 'package-lock.json': lockV3 }));
  assert.deepEqual([a[0].resolved, a[0].major, a[0].source, a[0].certified], ['14.2.3', 14, 'lockfile', true]);
  const b = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '^13.0.0' }), 'package-lock.json': lockV1 }));
  assert.equal(b[0].resolved, '13.5.6');
});

test('resolved beats declared', () => {
  const lock = JSON.stringify({ packages: { 'node_modules/express': { version: '5.0.1' } } });
  const d = detectFrameworkVersions(setup({ 'package.json': pkg({ express: '^4.0.0' }), 'package-lock.json': lock }));
  assert.equal(d[0].major, 5);
  assert.equal(d[0].declared, '^4.0.0');
});

test('pnpm-lock forms', () => {
  const importer = "importers:\n  .:\n    dependencies:\n      next:\n        specifier: ^14.0.0\n        version: 14.2.3(react-dom@18.2.0)(react@18.2.0)\n";
  const slash = "packages:\n\n  /next@13.4.1(react@18):\n    resolution: {}\n";
  const bare = "packages:\n\n  next@15.0.1:\n    resolution: {}\n";
  for (const [lock, want] of [[importer, '14.2.3'], [slash, '13.4.1'], [bare, '15.0.1']]) {
    const d = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '*' }), 'pnpm-lock.yaml': lock }));
    assert.equal(d[0].resolved, want);
    assert.equal(d[0].source, 'lockfile');
  }
});

test('yarn classic and berry', () => {
  const classic = '# yarn lockfile v1\n\n\n"next@^14.0.0", next@^14.1.0:\n  version "14.2.3"\n  resolved "x"\n';
  const berry = '__metadata:\n  version: 8\n\n"next@npm:^15.0.0":\n  version: 15.1.0\n  resolution: "next@npm:15.1.0"\n';
  const a = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '^14.0.0' }), 'yarn.lock': classic }));
  assert.equal(a[0].resolved, '14.2.3');
  const b = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '^15.0.0' }), 'yarn.lock': berry }));
  assert.equal(b[0].resolved, '15.1.0');
});

test('monorepo lockfile above project, nearest workspace entry wins', () => {
  const lock = JSON.stringify({ packages: {
    'node_modules/next': { version: '12.0.0' },
    'apps/web/node_modules/next': { version: '14.2.3' },
  } });
  const ctx = setup({ 'apps/web/package.json': pkg({ next: '^14.0.0' }), 'package-lock.json': lock }, 'apps/web');
  const d = detectFrameworkVersions(ctx);
  assert.equal(d[0].resolved, '14.2.3');
  const ctx2 = setup({ 'apps/web/package.json': pkg({ next: '^12.0.0' }), 'package-lock.json': lock }, 'apps/web');
  assert.equal(detectFrameworkVersions(ctx2)[0].resolved, '14.2.3');
});

test('malformed files never throw and are skipped', () => {
  const ctx = setup({ 'package.json': pkg({ next: '^14.0.0' }), 'package-lock.json': '{not json' });
  const d = detectFrameworkVersions(ctx);
  assert.equal(d[0].source, 'package.json');
  assert.equal(d[0].major, 14);
  assert.deepEqual(detectFrameworkVersions(setup({ 'package.json': '{oops' })), []);
  assert.deepEqual(detectFrameworkVersions(setup({})), []);
});

test('uncertified major and sorting, readFile injection', () => {
  const files: Record<string, string> = {
    '/r/package.json': JSON.stringify({ dependencies: { next: '12.3.0', koa: '^2.0.0' }, devDependencies: { express: '^4.18.0', '@nestjs/core': '^10.0.0' } }),
  };
  const d = detectFrameworkVersions({ projectRoot: '/r', repoRoot: '/r', readFile: (p) => files[p] });
  assert.deepEqual(d.map((x) => x.framework), ['@nestjs/core', 'express', 'koa', 'next']);
  const byName = Object.fromEntries(d.map((x) => [x.framework, x]));
  assert.equal(byName.next.certified, false);
  assert.equal(byName.express.certified, true);
  assert.equal(byName.koa.certified, false);
});

test('nextRouterRules and frameworkLabel', () => {
  assert.deepEqual(nextRouterRules(), { appRouter: true, pagesRouter: true });
  assert.deepEqual(nextRouterRules(12), { appRouter: false, pagesRouter: true });
  assert.deepEqual(nextRouterRules(13), { appRouter: true, pagesRouter: true });
  assert.equal(frameworkLabel({ framework: 'next', major: 14 }), 'nextjs@14');
  assert.equal(frameworkLabel({ framework: 'express', major: 4 }), 'express@4');
  assert.equal(frameworkLabel({ framework: '@nestjs/core', major: 10 }), 'nestjs@10');
  assert.equal(frameworkLabel({ framework: 'next' }), undefined);
});
