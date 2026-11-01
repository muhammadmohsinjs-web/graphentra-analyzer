import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { analyzeRepository } from '../src/analyze';
import { bracketNestingDepth, MAX_NESTING_DEPTH } from '../src/input-limits';
import { createRepositoryContext } from '../src/repository';
import { captureSourceSnapshot } from '../src/source-snapshot';
import { createRepo } from './helpers/git-fixture';

test('Git inventory excludes ignored untracked source but retains tracked ignored source', () => {
  const repo = createRepo();
  try {
    repo.commitFile('tracked.ts', 'export function tracked() {}');
    repo.commitFile('.gitignore', '*.ts\n');
    fs.writeFileSync(path.join(repo.dir, 'ignored.ts'), 'export function ignored() {}');
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base: 'HEAD', head: 'HEAD' } });
    assert.deepEqual(result.technicalGraph.analyzedFiles, ['tracked.ts']);
    assert.match(result.evidence.sourceState.contentIdentity!, /^[a-f0-9]{64}$/);
  } finally { repo.cleanup(); }
});

test('target-relative file and directory exclusions apply to dirty and untracked files', () => {
  const repo = createRepo();
  try {
    repo.commitFile('keep.ts', 'export function keep() {}');
    repo.commitFile('excluded.ts', 'export function excluded() {}');
    fs.writeFileSync(path.join(repo.dir, 'excluded.ts'), 'changed');
    fs.mkdirSync(path.join(repo.dir, 'skip'));
    fs.writeFileSync(path.join(repo.dir, 'skip/new.ts'), 'export function newFile() {}');
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base: 'HEAD', head: 'HEAD' },
      excludePaths: ['excluded.ts', 'skip'] });
    assert.deepEqual(result.technicalGraph.analyzedFiles, ['keep.ts']);
  } finally { repo.cleanup(); }
});

for (const mutation of ['modify', 'add', 'delete', 'config', 'head']) {
  test(`snapshot rejects ${mutation} after capture`, () => {
    const repo = createRepo();
    try {
      repo.commitFile('a.ts', 'export function a() {}');
      const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }));
      if (mutation === 'modify') fs.writeFileSync(path.join(repo.dir, 'a.ts'), 'export function b() {}');
      if (mutation === 'add') fs.writeFileSync(path.join(repo.dir, 'b.ts'), 'export function b() {}');
      if (mutation === 'delete') fs.unlinkSync(path.join(repo.dir, 'a.ts'));
      if (mutation === 'config') fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'), '{}');
      if (mutation === 'head') repo.git(['commit', '--allow-empty', '-m', 'next']);
      assert.throws(() => snapshot.verify(), { code: 'SOURCE_CHANGED' });
    } finally { repo.cleanup(); }
  });
}

test('captured bytes do not change after source mutation', () => {
  const repo = createRepo();
  try {
    const content = 'export function a() {}';
    repo.commitFile('a.ts', content);
    const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }));
    fs.writeFileSync(path.join(repo.dir, 'a.ts'), 'export function b() {}');
    assert.equal(snapshot.readFile(path.join(repo.dir, 'a.ts')), content);
    assert.throws(snapshot.verify, { code: 'SOURCE_CHANGED' });
  } finally { repo.cleanup(); }
});

test('external source symlinks are skipped, not analyzed', () => {
  const repo = createRepo();
  const external = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() {}');
    external.commitFile('external.ts', 'export function external() {}');
    fs.symlinkSync(path.join(external.dir, 'external.ts'), path.join(repo.dir, 'linked.ts'));
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.deepEqual(result.technicalGraph.analyzedFiles, ['a.ts']);
    const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }));
    assert.deepEqual(snapshot.skipped, [{ file: 'linked.ts', reason: 'symlink' }]);
  } finally { repo.cleanup(); external.cleanup(); }
});

test('external configuration extends is rejected', () => {
  const repo = createRepo();
  const external = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() {}');
    external.commitFile('tsconfig.json', '{}');
    fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'), JSON.stringify({ extends: path.join(external.dir, 'tsconfig.json') }));
    assert.throws(() => analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } }),
      { code: 'INVALID_OPTIONS' });
  } finally { repo.cleanup(); external.cleanup(); }
});

test('nested target ignores parent tsconfig and sibling source', () => {
  const repo = createRepo();
  try {
    repo.commitFile('tsconfig.json', '{ invalid');
    repo.commitFile('sibling.ts', 'export function sibling() {}');
    repo.commitFile('target/a.ts', 'export function a() {}');
    const result = analyzeRepository({ target: path.join(repo.dir, 'target'), comparison: { mode: 'working-tree' } });
    assert.deepEqual(result.technicalGraph.analyzedFiles, ['a.ts']);
  } finally { repo.cleanup(); }
});

for (const name of ['space file.ts', 'quote"file.ts', '日本語.ts', 'tab\tfile.ts']) {
  test(`untracked source is rejected independent of Git quoting: ${JSON.stringify(name)}`, () => {
    const repo = createRepo();
    try {
      repo.commitFile('a.ts', 'export function a() {}');
      fs.writeFileSync(path.join(repo.dir, name), 'export function b() {}');
      assert.throws(() => analyzeRepository({ target: repo.dir,
        comparison: { mode: 'commit', base: 'HEAD', head: 'HEAD' } }), { code: 'DIRTY_UNTRACKED_SOURCE' });
    } finally { repo.cleanup(); }
  });
}

const nested = (depth: number) => `export const deep = ${'('.repeat(depth)}1${')'.repeat(depth)};\nexport function ok() { return deep; }\n`;

test('D14: bracket nesting is measured on tokens; strings, comments, regexes and templates do not count', () => {
  assert.equal(MAX_NESTING_DEPTH, 500);
  assert.equal(bracketNestingDepth('((((1))))', 2), 3, 'stops early once the limit is exceeded');
  assert.equal(bracketNestingDepth(`${'('.repeat(600)}${')'.repeat(600)}`), 501);
  const noise = `const a = "${'('.repeat(700)}"; // ${'['.repeat(700)}\nconst b = /${'\\('.repeat(700)}/; const c = \`${'{'.repeat(700)}\`;`;
  assert.equal(bracketNestingDepth(noise), 0);
  assert.equal(bracketNestingDepth(`const t = \`a \${${'('.repeat(550)}1${')'.repeat(550)}} b\`;`), 501);
  assert.equal(bracketNestingDepth(`${'['.repeat(300)}${'{'.repeat(300)}`), 501);
});

for (const [depth, parsed] of [[600, false], [400, true]] as const) {
  test(`D14: nesting depth ${depth} is ${parsed ? 'parsed' : 'skipped as parse_failed without parsing'}`, () => {
    const repo = createRepo();
    try {
      repo.commitFile('deep.ts', nested(depth));
      repo.commitFile('other.ts', 'export function other() { return 1; }');
      const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }), 'extended');
      const program = ts.createProgram(snapshot.files, snapshot.compilerOptions, snapshot.host);
      assert.equal(program.getSourceFiles().some(file => path.basename(file.fileName) === 'deep.ts'), parsed);
      assert.deepEqual(snapshot.skipped, parsed ? [] : [{ file: 'deep.ts', reason: 'parse_failed' }]);
      const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'extended' });
      assert.equal(result.technicalGraph.analyzedFiles.includes('deep.ts'), parsed);
      assert.ok(result.technicalGraph.analyzedFiles.includes('other.ts'));
    } finally { repo.cleanup(); }
  });
}
