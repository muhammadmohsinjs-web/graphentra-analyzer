import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createFrameworkVersionResolver, detectFrameworkVersions, frameworkLabel, nextRouterRules } from '../src/framework-version';

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

test('pnpm workspace lockfile: the importer whose key is the project path wins, never the first importer', () => {
  const entry = (v: string) => `      next:\n        specifier: ^${v.split('.')[0]}.0.0\n        version: ${v}(react@18.2.0)\n`;
  const lock = 'lockfileVersion: \'9.0\'\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: 5.0.0\n        version: 5.0.0\n\n' +
    `  apps/admin:\n    dependencies:\n${entry('13.5.6')}\n  apps/web:\n    peerDependencies:\n${entry('12.0.0')}    devDependencies:\n${entry('15.0.1')}\n` +
    'packages:\n\n  next@13.5.6:\n    resolution: {}\n';
  const files = { 'pnpm-lock.yaml': lock, 'apps/web/package.json': pkg({ next: '*' }), 'apps/admin/package.json': pkg({ next: '*' }),
    'apps/none/package.json': pkg({ next: '^14.0.0' }) };
  assert.equal(detectFrameworkVersions(setup(files, 'apps/web'))[0].resolved, '15.0.1');
  assert.equal(detectFrameworkVersions(setup(files, 'apps/admin'))[0].resolved, '13.5.6');
  const none = detectFrameworkVersions(setup(files, 'apps/none'))[0];
  assert.equal(none.resolved, undefined, 'no importer for the project: no other workspace version is borrowed');
  assert.equal(none.major, 14);
});

test('peerDependencies are not read (D11: dependencies and devDependencies only)', () => {
  const peerOnly = JSON.stringify({ peerDependencies: { next: '^14.0.0' } });
  assert.deepEqual(detectFrameworkVersions(setup({ 'package.json': peerOnly })), []);
  const both = JSON.stringify({ peerDependencies: { next: '^12.0.0' }, devDependencies: { next: '^14.0.0' } });
  assert.equal(detectFrameworkVersions(setup({ 'package.json': both }))[0].major, 14);
});

test('yarn classic and berry', () => {
  const classic = '# yarn lockfile v1\n\n\n"next@^14.0.0", next@^14.1.0:\n  version "14.2.3"\n  resolved "x"\n';
  const berry = '__metadata:\n  version: 8\n\n"next@npm:^15.0.0":\n  version: 15.1.0\n  resolution: "next@npm:15.1.0"\n';
  const a = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '^14.0.0' }), 'yarn.lock': classic }));
  assert.equal(a[0].resolved, '14.2.3');
  const b = detectFrameworkVersions(setup({ 'package.json': pkg({ next: '^15.0.0' }), 'yarn.lock': berry }));
  assert.equal(b[0].resolved, '15.1.0');
});

test('yarn workspace lockfile: an entry whose key does not list the declared range is never borrowed', () => {
  // apps/api declares express ^3.0.0; the only express entry is another workspace's ^4.18.0.
  const lock = '# yarn lockfile v1\n\n\nexpress@^4.18.0:\n  version "4.18.2"\n  resolved "x"\n\n"next@^14.0.0":\n  version "14.2.3"\n';
  const [api] = detectFrameworkVersions(setup({ 'yarn.lock': lock, 'apps/api/package.json': pkg({ express: '^3.0.0' }) }, 'apps/api'));
  assert.equal(api.resolved, undefined);
  assert.equal(api.source, 'package.json');
  assert.equal(api.major, 3);
  assert.equal(api.certified, false);
  const [web] = detectFrameworkVersions(setup({ 'yarn.lock': lock, 'apps/web/package.json': pkg({ next: '^14.0.0' }) }, 'apps/web'));
  assert.equal(web.resolved, '14.2.3');
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

test('per-file resolver: the nearest manifest naming the framework wins; peer-only there means unknown', () => {
  const roots = setup({
    'package.json': pkg({ next: '14.2.3', express: '4.18.2' }),
    'apps/web/package.json': pkg({ next: '12.3.4' }),
    'apps/lib/package.json': JSON.stringify({ peerDependencies: { next: '>=13' } }),
  });
  const forFile = createFrameworkVersionResolver(roots);
  const summary = (file: string) => forFile(file).map(d => `${d.framework}@${d.major}:${d.certified}`);
  assert.deepEqual(summary('apps/web/app/page.tsx'), ['express@4:true', 'next@12:false']);
  assert.deepEqual(summary('apps/lib/src/x.ts'), ['express@4:true'], 'peer-only next: unknown, the root version is not used');
  assert.deepEqual(summary('src/server.ts'), ['express@4:true', 'next@14:true']);
});
