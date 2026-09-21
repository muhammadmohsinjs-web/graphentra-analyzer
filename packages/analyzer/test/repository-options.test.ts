import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositoryContext } from '../src/repository';
import { createRepo } from './helpers/git-fixture';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeRepository } from '../src/analyze';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('invalid comparison shapes fail before target discovery', () => {
  for (const comparison of [
    { mode: 'working-tree', base: '' }, { mode: 'working-tree', base: '   ' },
    { mode: 'working-tree', head: 'HEAD' },
    { mode: 'commit', base: '--help', head: 'HEAD' },
    { mode: 'commit', base: 'HEAD', head: 'HEAD', extra: true },
  ]) {
    assert.throws(() => createRepositoryContext('/missing-target', comparison as any),
      { code: 'INVALID_REVISION' });
  }
});

test('invalid timeout and exclusions fail before target discovery', () => {
  for (const options of [
    { gitTimeoutMs: 0 }, { gitTimeoutMs: NaN }, { gitTimeoutMs: -1 },
    { gitTimeoutMs: 1.5 }, { excludePaths: ['/tmp'] },
    { excludePaths: ['../source'] }, { excludePaths: ['src/../source'] },
    { excludePaths: ['C:\\source'] }, { excludePaths: [''] },
  ]) assert.throws(() => createRepositoryContext('/missing-target', { mode: 'working-tree' }, options),
    { code: 'INVALID_OPTIONS' });
});

test('baseline reads preserve exact trailing whitespace', () => {
  const repo = createRepo();
  try {
    const content = 'export function a() {}\n\n  \n';
    const sha = repo.commitFile('a.ts', content);
    const context = createRepositoryContext(repo.dir, { mode: 'working-tree' });
    assert.equal(context.getBaselineSource('a.ts', sha), content);
    assert.throws(() => context.getBaselineSource('missing.ts', sha), { code: 'BASELINE_SOURCE_FAILED' });
  } finally { repo.cleanup(); }
});

test('missing Git retains its stable error code', () => {
  const repo = createRepo();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = repo.dir;
    assert.throws(() => createRepositoryContext(repo.dir, { mode: 'working-tree' }), { code: 'GIT_NOT_FOUND' });
  } finally { process.env.PATH = originalPath; repo.cleanup(); }
});

test('Git timeout retains its stable error code', () => {
  const repo = createRepo();
  const originalPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(repo.dir, 'git'), '#!/bin/sh\nexec /bin/sleep 2\n', { mode: 0o700 });
    process.env.PATH = repo.dir;
    assert.throws(() => createRepositoryContext(repo.dir, { mode: 'working-tree' }, { gitTimeoutMs: 20 }),
      { code: 'GIT_TIMEOUT' });
  } finally { process.env.PATH = originalPath; repo.cleanup(); }
});

test('diff disables target textconv and external helpers', () => {
  const repo = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() { return 1; }');
    repo.commitFile('.gitattributes', '*.ts diff=unsafe\n');
    const helper = path.join(repo.dir, 'helper');
    const marker = path.join(repo.dir, 'executed');
    fs.writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    repo.git(['config', 'diff.unsafe.textconv', helper]);
    repo.git(['config', 'diff.external', helper]);
    fs.writeFileSync(path.join(repo.dir, 'a.ts'), 'export function a() { return 2; }');
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.equal(result.outcome, 'completed');
    assert.equal(fs.existsSync(marker), false);
  } finally { repo.cleanup(); }
});

test('shallow missing ancestors report fetch guidance even without source files', () => {
  const repo = createRepo();
  const destination = createRepo();
  try {
    repo.commitFile('README.md', 'one');
    repo.commitFile('README.md', 'two');
    destination.cleanup();
    execFileSync('git', ['clone', '--depth=1', pathToFileURL(repo.dir).href, destination.dir], { stdio: 'pipe' });
    assert.throws(() => analyzeRepository({ target: destination.dir,
      comparison: { mode: 'commit', base: 'HEAD~1', head: 'HEAD' } }),
      (error: any) => error.code === 'MISSING_HISTORY' && /Fetch/.test(error.message));
  } finally { repo.cleanup(); destination.cleanup(); }
});
