import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyNonTsFile, diffPackageJson, nonTsChangeDiagnostics, type NonTsChangeClass } from '../src/non-ts-changes';

const cases: Array<[string, NonTsChangeClass]> = [
  ['package.json', 'DEPENDENCY_CHANGE'],
  ['apps/web/package.json', 'DEPENDENCY_CHANGE'],
  ['package-lock.json', 'DEPENDENCY_CHANGE'],
  ['yarn.lock', 'DEPENDENCY_CHANGE'],
  ['pnpm-lock.yaml', 'DEPENDENCY_CHANGE'],
  ['bun.lockb', 'DEPENDENCY_CHANGE'],
  ['npm-shrinkwrap.json', 'DEPENDENCY_CHANGE'],
  ['prisma/schema.prisma', 'SCHEMA_CHANGE'],
  ['db/init.sql', 'SCHEMA_CHANGE'],
  ['prisma/migrations/2024_init/migration.sql', 'SCHEMA_CHANGE'],
  ['db/migrations/README.md', 'SCHEMA_CHANGE'],
  ['.env', 'ENV_CONFIG_CHANGE'],
  ['.env.example', 'ENV_CONFIG_CHANGE'],
  ['vite.config.js', 'ENV_CONFIG_CHANGE'],
  ['tsconfig.json', 'ENV_CONFIG_CHANGE'],
  ['tsconfig.build.json', 'ENV_CONFIG_CHANGE'],
  ['config/app.yml', 'ENV_CONFIG_CHANGE'],
  ['pyproject.toml', 'ENV_CONFIG_CHANGE'],
  ['setup.ini', 'ENV_CONFIG_CHANGE'],
  ['.github/workflows/ci.yml', 'CI_CONFIG_CHANGE'],
  ['.gitlab-ci.yml', 'CI_CONFIG_CHANGE'],
  ['.circleci/config.yml', 'CI_CONFIG_CHANGE'],
  ['Dockerfile', 'CI_CONFIG_CHANGE'],
  ['docker/Dockerfile.prod', 'CI_CONFIG_CHANGE'],
  ['logo.png', 'ASSET_ONLY'],
  ['fonts/a.woff2', 'ASSET_ONLY'],
  ['styles/app.scss', 'ASSET_ONLY'],
  ['README.md', 'OTHER'],
  ['src/a.py', 'OTHER'],
];

for (const [file, expected] of cases) {
  test(`classify ${file}`, () => assert.equal(classifyNonTsFile(file), expected));
}

test('diffPackageJson detects bumped, added, removed deps', () => {
  const base = JSON.stringify({ dependencies: { lodash: '4.0.0' }, devDependencies: { typescript: '5.4.0' } });
  const head = JSON.stringify({ dependencies: { react: '18.3.1' }, devDependencies: { typescript: '5.6.2' } });
  assert.deepEqual(diffPackageJson(base, head), {
    added: [{ name: 'react', version: '18.3.1', section: 'dependencies' }],
    removed: [{ name: 'lodash', version: '4.0.0', section: 'dependencies' }],
    changed: [{ name: 'typescript', from: '5.4.0', to: '5.6.2', section: 'devDependencies' }],
  });
});

test('diffPackageJson returns null on invalid JSON', () => {
  assert.equal(diffPackageJson('{', '{}'), null);
  assert.equal(diffPackageJson('{}', 'nope'), null);
});

const reader = (base: Record<string, string>, head: Record<string, string>) => ({
  base: (f: string) => base[f],
  head: (f: string) => head[f],
});

test('package.json message lists added, removed, changed', () => {
  const r = reader(
    { 'package.json': JSON.stringify({ dependencies: { lodash: '4.0.0' }, devDependencies: { typescript: '5.4.0' } }) },
    { 'package.json': JSON.stringify({ dependencies: { react: '18.3.1' }, devDependencies: { typescript: '5.6.2' } }) },
  );
  const out = nonTsChangeDiagnostics([{ file: 'package.json', status: 'modified' }], r);
  assert.deepEqual(out, [{
    code: 'DEPENDENCY_CHANGE', severity: 'warning', file: 'package.json',
    message: 'added react@18.3.1; removed lodash; changed typescript 5.4.0 → 5.6.2',
  }]);
});

test('package.json message caps at 20 names', () => {
  const deps: Record<string, string> = {};
  for (let i = 0; i < 25; i++) deps[`d${String(i).padStart(2, '0')}`] = '1.0.0';
  const r = reader({ 'package.json': '{}' }, { 'package.json': JSON.stringify({ dependencies: deps }) });
  const [d] = nonTsChangeDiagnostics([{ file: 'package.json' }], r);
  assert.ok(d.message.endsWith('and 5 more'));
  assert.ok(d.message.includes('d19@1.0.0') && !d.message.includes('d20@'));
});

test('invalid package.json is reported as unparseable', () => {
  const [d] = nonTsChangeDiagnostics([{ file: 'package.json' }], reader({ 'package.json': '{}' }, { 'package.json': '{oops' }));
  assert.equal(d.code, 'DEPENDENCY_CHANGE');
  assert.ok(d.message.includes('unparseable package.json'));
});

test('prisma migration and .env.example get typed warnings', () => {
  const out = nonTsChangeDiagnostics(
    [{ file: '.env.example', status: 'modified' }, { file: 'prisma/migrations/1/migration.sql', status: 'added' }],
    reader({}, {}),
  );
  assert.deepEqual(out.map((d) => [d.file, d.code, d.severity]), [
    ['.env.example', 'ENV_CONFIG_CHANGE', 'warning'],
    ['prisma/migrations/1/migration.sql', 'SCHEMA_CHANGE', 'warning'],
  ]);
});

test('output is deterministic regardless of input order', () => {
  const files = ['z.png', 'package.json', 'a.sql', '.env', 'Dockerfile', 'notes.md'].map((file) => ({ file }));
  const r = reader({ 'package.json': '{}' }, { 'package.json': '{"dependencies":{"x":"1"}}' });
  const a = nonTsChangeDiagnostics(files, r);
  const b = nonTsChangeDiagnostics([...files].reverse(), r);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((d) => d.file), [...a.map((d) => d.file)].sort());
});
