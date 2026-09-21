import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { createRepo } from './helpers/git-fixture';

for (const name of ['space file.ts', 'tab\tfile.ts', 'quote"file.ts', 'slash\\file.ts', '日本語.ts', 'emoji😀.ts']) {
  test(`untracked addition yields function impact for ${JSON.stringify(name)}`, () => {
    const repo = createRepo();
    try {
      repo.commitFile('a.ts', 'export function a() {}');
      fs.writeFileSync(path.join(repo.dir, name), 'export function added() { return 1; }\nexport function caller() { return added(); }\n');
      const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
      assert.equal(result.outcome, 'completed');
      const impact = result.impacts.find(item => item.changedEntity.name === 'added')!;
      assert.ok(impact);
      assert.equal(impact.changedEntity.file, name);
      assert.deepEqual(impact.directDependents.map(item => item.name), ['caller']);
      assert.equal(repo.git(['diff', '--cached']), '');
    } finally { repo.cleanup(); }
  });
}

test('non-TypeScript changes are unsupported rather than no changes', () => {
  const repo = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() {}');
    repo.commitFile('README.md', 'before');
    fs.writeFileSync(path.join(repo.dir, 'README.md'), 'after');
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.equal(result.outcome, 'no_supported_changes');
    assert.equal(result.changedFiles[0]?.file, 'README.md');
    assert.ok(result.diagnostics.some(item => item.code === 'OUTSIDE_SUPPORTED_SCOPE'));
  } finally { repo.cleanup(); }
});

test('deleting the last source retains deletion evidence with no_source_files outcome', () => {
  const repo = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() {}');
    fs.unlinkSync(path.join(repo.dir, 'a.ts'));
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.equal(result.outcome, 'no_source_files');
    assert.equal(result.changedFiles[0]?.file, 'a.ts');
    assert.deepEqual(result.changedFiles[0]?.removedCode, ['export function a() {}']);
    assert.deepEqual(result.impacts, []);
  } finally { repo.cleanup(); }
});

for (const direction of ['incoming', 'outgoing', 'internal']) {
  test(`nested target ${direction} rename has target-relative evidence`, () => {
    const repo = createRepo();
    try {
      repo.commitFile('target/keep.ts', 'export function keep() {}');
      const oldFile = direction === 'incoming' ? 'outside.ts' : 'target/before.ts';
      const newFile = direction === 'outgoing' ? 'outside.ts' : 'target/after.ts';
      const base = repo.commitFile(oldFile, 'export function renamed() {\n  return 1;\n}\n');
      repo.git(['mv', oldFile, newFile]);
      fs.writeFileSync(path.join(repo.dir, newFile), 'export function renamed() {\n  return 2;\n}\n');
      repo.git(['add', '.']);
      repo.git(['commit', '-m', 'rename']);
      const result = analyzeRepository({ target: path.join(repo.dir, 'target'),
        comparison: { mode: 'commit', base, head: 'HEAD' } });
      assert.ok(result.changedFiles.length > 0);
      assert.ok(result.changedFiles.every(item => !item.file.startsWith('../') && !item.file.startsWith('target/')));
      assert.equal(result.outcome, direction === 'outgoing' ? 'no_supported_changes' : 'completed');
      if (direction === 'incoming') assert.equal(result.changedFiles[0]?.oldFile, undefined);
      if (direction === 'internal') assert.equal(result.changedFiles[0]?.oldFile, 'before.ts');
    } finally { repo.cleanup(); }
  });
}
