import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRepository } from '../src/index';
import { classifyFileOrigin, type FileOrigin } from '../src/file-origin';
import { createRepo } from './helpers/git-fixture';

const cases: Array<[string, string, Parameters<typeof classifyFileOrigin>[1], FileOrigin]> = [
  ['attribute generated', 'src/a.ts', { attributes: { generated: true } }, 'generated'],
  ['attribute vendored', 'src/a.ts', { attributes: { vendored: true } }, 'vendored'],
  ['attribute false', 'src/a.ts', { attributes: {} }, 'source'],
  ['attribute beats path', 'dist/a.ts', { attributes: { vendored: true } }, 'vendored'],
  ['dist dir', 'dist/a.js', {}, 'build_output'],
  ['nested .next dir', 'web/.next/server/a.js', {}, 'build_output'],
  ['out dir', 'out/a.js', {}, 'build_output'],
  ['build dir', 'pkg/build/a.js', {}, 'build_output'],
  ['file named dist is not a dir', 'src/dist.ts', {}, 'source'],
  ['vendor dir', 'src/vendor/lib.ts', {}, 'vendored'],
  ['node_modules dir', 'node_modules/x/index.js', {}, 'vendored'],
  ['vendor-like name', 'src/vendors.ts', {}, 'source'],
  ['__generated__ dir', 'src/__generated__/client.ts', {}, 'generated'],
  ['.generated. name', 'src/schema.generated.ts', {}, 'generated'],
  ['.gen. name', 'src/api.gen.ts', {}, 'generated'],
  ['.pb. name', 'src/msg.pb.ts', {}, 'generated'],
  ['.min.js name', 'src/app.min.js', {}, 'minified'],
  ['gen without dots', 'src/general.ts', {}, 'source'],
  ['@generated header', 'src/a.ts', { content: '// @generated\nexport const a = 1;\n' }, 'generated'],
  ['DO NOT EDIT header', 'src/a.ts', { content: '/* Do Not Edit */\nexport const a = 1;\n' }, 'generated'],
  ['auto-generated header', 'src/a.ts', { content: '// This file is Auto-Generated\nexport const a = 1;\n' }, 'generated'],
  ['marker after line 5', 'src/a.ts', { content: '1\n2\n3\n4\n5\n// @generated\n' }, 'source'],
  ['long average line', 'src/a.js', { content: `${'x'.repeat(600)}\n` }, 'minified'],
  ['one huge line', 'src/a.js', { content: `${'x'.repeat(10_001)}\n${'y\n'.repeat(100_000)}` }, 'minified'],
  ['normal source', 'src/a.ts', { content: 'export const a = 1;\nexport const b = 2;\n' }, 'source'],
  ['no content', 'src/a.ts', {}, 'source'],
];

for (const [name, file, options, expected] of cases) {
  test(`classifyFileOrigin: ${name}`, () => assert.equal(classifyFileOrigin(file, options), expected));
}

const SOURCE = 'export function work(value: number): number {\n  return value + 1;\n}\n';
const CALLER = "import { work } from './work';\nexport function run(): number {\n  return work(1);\n}\n";

function analyze(setup: (repo: ReturnType<typeof createRepo>) => void) {
  const repo = createRepo('graphentra-origin-');
  try {
    repo.commitFile('src/work.ts', SOURCE);
    repo.commitFile('src/main.ts', CALLER);
    setup(repo);
    const head = repo.git(['rev-parse', 'HEAD']);
    return analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base: 'HEAD~1', head }, engine: 'extended' });
  } finally {
    repo.cleanup();
  }
}

const originDiagnostics = (result: ReturnType<typeof analyze>) =>
  result.diagnostics.filter(item => item.code === 'GENERATED_FILES_CHANGED');

test('regenerated client in __generated__ is reported but not traversed', () => {
  const result = analyze(repo => {
    repo.commitFile('src/__generated__/client.ts', 'export function call(): number {\n  return 1;\n}\n');
    repo.commitFile('src/__generated__/client.ts', 'export function call(): number {\n  return 2;\n}\n');
  });
  assert.equal(result.impacts.length, 0);
  assert.equal(result.changedEntities.length, 0);
  assert.ok(result.changedFiles.some(change => change.file === 'src/__generated__/client.ts'));
  const diagnostics = originDiagnostics(result);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'info');
  assert.equal(diagnostics[0].message,
    'Changes in non-source files were reported but not traversed: src/__generated__/client.ts (generated)');
});

test('source change alongside generated change still gets impacts', () => {
  const result = analyze(repo => {
    repo.commitFile('src/__generated__/client.ts', 'export const a = 1;\n');
    repo.commitFile('src/work.ts', SOURCE.replace('+ 1', '+ 2'));
    repo.git(['commit', '--amend', '--no-edit']);
  });
  assert.ok(result.impacts.length > 0);
  assert.ok(result.impacts.every(impact => impact.changedEntity.file !== 'src/__generated__/client.ts'));
});

test('.gitattributes linguist-generated marks a file generated', () => {
  const result = analyze(repo => {
    repo.commitFile('.gitattributes', 'src/api.ts linguist-generated\nsrc/lib.ts linguist-vendored=true\nsrc/keep.ts -linguist-generated\n');
    repo.commitFile('src/api.ts', 'export function api(): number {\n  return 1;\n}\n');
    repo.commitFile('src/lib.ts', 'export function lib(): number {\n  return 1;\n}\n');
    repo.commitFile('src/keep.ts', 'export function keep(): number {\n  return 1;\n}\n');
    repo.git(['reset', '--soft', 'HEAD~3']);
    repo.git(['commit', '-m', 'attrs']);
  });
  const diagnostics = originDiagnostics(result);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].message.endsWith('src/api.ts (generated), src/lib.ts (vendored)'));
  assert.deepEqual([...new Set(result.changedEntities.map(item => item.entity.file))], ['src/keep.ts']);
});

test('minified one-line file is reported but not traversed', () => {
  const line = `function a(){return 1}${'var b=1;'.repeat(200)}`;
  const result = analyze(repo => {
    repo.commitFile('src/bundle.js', `${line}\n`);
    repo.commitFile('src/bundle.js', `${line}function c(){return 2}\n`);
  });
  assert.equal(result.impacts.length, 0);
  assert.equal(originDiagnostics(result).length, 1);
  assert.ok(originDiagnostics(result)[0].message.endsWith('src/bundle.js (minified)'));
});
