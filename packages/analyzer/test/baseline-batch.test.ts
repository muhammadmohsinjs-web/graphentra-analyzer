import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { BaselineSourceError } from '../src/errors';
import { createRepositoryContext } from '../src/repository';
import { createRepo } from './helpers/git-fixture';

/** Counts git spawns by subcommand while `run` executes, using a logging `git` wrapper first on PATH. */
function countGit<T>(run: () => T): { result: T; counts: Record<string, number> } {
  const realGit = childProcess.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-gitspy-'));
  const log = path.join(dir, 'log');
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in -*|core.*|commit.*) ;; *) echo "$a" >> '${log}'; break;; esac; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  try {
    const result = run();
    const counts: Record<string, number> = {};
    if (fs.existsSync(log)) for (const sub of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) counts[sub] = (counts[sub] ?? 0) + 1;
    return { result, counts };
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('batched baseline reads return the same bytes and errors as unbatched reads', () => {
  const repo = createRepo();
  try {
    const files: Record<string, Buffer> = {
      'a.ts': Buffer.from('export const a = 1;\n'),
      'bin.dat': Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x0a, 0x41, 0x00]),
      'dir with space/ünï côde.ts': Buffer.from('export const é = "ü";\r\n'),
      'empty.ts': Buffer.alloc(0),
      'big.txt': Buffer.alloc(5000, 0x61),
    };
    for (const [name, bytes] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, name)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, name), bytes);
    }
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    const base = repo.git(['rev-parse', 'HEAD']);
    const names = [...Object.keys(files), 'missing.ts'];

    const read = (context: ReturnType<typeof createRepositoryContext>) => names.map(name => {
      try { return { blob: context.getBaselineBlob(name, base), source: context.getBaselineSource(name, base) }; }
      catch (error) { return { error: error instanceof BaselineSourceError ? error.constructor.name : String(error) }; }
    });
    const unbatched = read(createRepositoryContext(repo.dir, { mode: 'working-tree' }));
    const batchedContext = createRepositoryContext(repo.dir, { mode: 'working-tree' });
    const { counts } = countGit(() => batchedContext.prefetchBaseline(base, names, 1000));
    const batched = read(batchedContext);

    assert.deepEqual(batched, unbatched);
    for (const [index, name] of Object.keys(files).entries()) assert.ok((unbatched[index] as any).blob.equals(files[name]), name);
    assert.deepEqual(unbatched[names.length - 1], { error: 'BaselineSourceError' });
    // One size pass and one content pass, regardless of the number of paths.
    assert.deepEqual(counts, { 'cat-file': 2 });
  } finally { repo.cleanup(); }
});

test('files over the byte limit are not buffered by the batch', () => {
  const repo = createRepo();
  try {
    repo.commitFile('big.txt', 'x'.repeat(5000));
    const context = createRepositoryContext(repo.dir, { mode: 'working-tree' });
    const base = repo.git(['rev-parse', 'HEAD']);
    const { counts } = countGit(() => { context.prefetchBaseline(base, ['big.txt'], 1000); });
    // Only the size pass runs: nothing is within the limit, so no content pass.
    assert.deepEqual(counts, { 'cat-file': 1 });
    assert.equal(context.getBaselineBlob('big.txt', base).length, 5000);
  } finally { repo.cleanup(); }
});

test('one analysis spawns git O(1) times for base reads, not O(files)', () => {
  const repo = createRepo();
  try {
    for (let index = 0; index < 300; index += 1) {
      fs.writeFileSync(path.join(repo.dir, `m${index}.ts`), `export const v${index} = ${index};\n`);
    }
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    fs.writeFileSync(path.join(repo.dir, 'm1.ts'), 'export const v1 = 100;\n');
    const { counts } = countGit(() => analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } }));
    assert.ok((counts['cat-file'] ?? 0) <= 4, JSON.stringify(counts));
    assert.ok((counts['show'] ?? 0) <= 5, JSON.stringify(counts));
  } finally { repo.cleanup(); }
});
