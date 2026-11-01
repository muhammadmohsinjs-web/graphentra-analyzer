import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepository, validateEvidenceEnvelope } from '../src/index';
import { buildCoverage, languageOf, mapSnapshotSkipReason, renderCoverageMarkdown } from '../src/coverage';
import { createRepo } from './helpers/git-fixture';

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function mixed() {
  return {
    changedFiles: [
      { file: 'src/a.ts', changedLines: range(1, 10) },
      { file: 'src/b.tsx', changedLines: [1, 2] },
      { file: 'tools/x.py', changedLines: [5, 6, 7] },
      { file: 'db/m.sql', changedLines: [1] },
      { file: 'logo.png', changedLines: [1] },
      { file: 'README.md', changedLines: [1, 2, 3, 4] },
    ],
    attributedLines: new Map([
      ['src/a.ts', new Set([1, 2, 3, 99])],
      ['src/b.tsx', new Set([1, 2])],
    ]),
    frontier: [{ file: 'src/a.ts' }, { file: 'src/a.ts' }, { file: 'tools/x.py' }],
    skipped: [
      { file: 'logo.png', reason: 'binary' as const },
      { file: 'big.js', reason: 'too_large' as const },
    ],
    frontierTotal: 3,
  };
}

test('mixed input produces expected rows', () => {
  const c = buildCoverage(mixed());
  assert.deepEqual(c.byLanguage, [
    { key: 'markdown', changedLines: 4, attributedLines: 0, ratio: 0, frontierCount: 0 },
    { key: 'other', changedLines: 1, attributedLines: 0, ratio: 0, frontierCount: 0 },
    { key: 'python', changedLines: 3, attributedLines: 0, ratio: 0, frontierCount: 1 },
    { key: 'sql', changedLines: 1, attributedLines: 0, ratio: 0, frontierCount: 0 },
    { key: 'typescript', changedLines: 12, attributedLines: 5, ratio: 0.4167, frontierCount: 2 },
  ]);
  assert.deepEqual(c.byDirectory.map(r => [r.key, r.changedLines, r.attributedLines, r.frontierCount]), [
    ['.', 5, 0, 0],
    ['db', 1, 0, 0],
    ['src', 12, 5, 2],
    ['tools', 3, 0, 1],
  ]);
  assert.deepEqual(c.skippedFiles, [{ file: 'big.js', reason: 'too_large' }, { file: 'logo.png', reason: 'binary' }]);
  assert.equal(c.frontierTotal, 3);
});

test('languageOf covers table and fallbacks', () => {
  assert.equal(languageOf('a/b.TS'), 'typescript');
  assert.equal(languageOf('schema.prisma'), 'prisma');
  assert.equal(languageOf('Makefile'), 'other');
  assert.equal(languageOf('.gitignore'), 'other');
});

test('ratio uses four decimal rounding', () => {
  const c = buildCoverage({ changedFiles: [{ file: 'a.ts', changedLines: [1, 2, 3] }], attributedLines: new Map([['a.ts', new Set([1])]]), frontier: [], skipped: [], frontierTotal: 0 });
  assert.equal(c.byLanguage[0].ratio, 0.3333);
});

test('zero changed lines gives ratio 0', () => {
  const c = buildCoverage({ changedFiles: [{ file: 'a.ts', changedLines: [] }], attributedLines: new Map(), frontier: [], skipped: [], frontierTotal: 0 });
  assert.equal(c.byLanguage[0].ratio, 0);
  assert.equal(c.byLanguage[0].changedLines, 0);
});

test('frontier counts per row', () => {
  const c = buildCoverage(mixed());
  assert.deepEqual(c.byLanguage.map(r => r.frontierCount), [0, 0, 1, 0, 2]);
});

test('snapshot skip reasons map to evidence reasons', () => {
  assert.equal(mapSnapshotSkipReason('too_large'), 'too_large');
  assert.equal(mapSnapshotSkipReason('binary'), 'binary');
  assert.equal(mapSnapshotSkipReason('invalid_encoding'), 'invalid_encoding');
  assert.equal(mapSnapshotSkipReason('symlink'), 'symlink');
  assert.equal(mapSnapshotSkipReason('input_limit'), 'too_large');
  assert.equal(mapSnapshotSkipReason('parse_failed'), 'parse_failure');
});

test('output is deterministic under input shuffling', () => {
  const a = mixed();
  const b = mixed();
  b.changedFiles.reverse();
  b.frontier.reverse();
  b.skipped.reverse();
  assert.deepEqual(buildCoverage(b), buildCoverage(a));
});

test('coverage validates inside a 2.1 envelope', () => {
  const repo = createRepo('graphentra-cov-');
  try {
    const base = repo.commitFile('src/app.ts', 'export function a(): number { return 1; }\n', 'c1');
    const head = repo.commitFile('src/app.ts', 'export function a(): number { return 2; }\n', 'c2');
    const evidence = JSON.parse(JSON.stringify(analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'extended' }).evidence));
    evidence.coverage = buildCoverage(mixed());
    assert.deepEqual(validateEvidenceEnvelope(evidence).errors, []);
  } finally {
    repo.cleanup();
  }
});

test('markdown renders tables and caps skipped list', () => {
  const input = mixed();
  input.skipped = range(1, 53).map(i => ({ file: `f${String(i).padStart(2, '0')}.bin`, reason: 'binary' as const }));
  const md = renderCoverageMarkdown(buildCoverage(input));
  assert.match(md, /\| typescript \| 12 \| 5 \| 0\.4167 \| 2 \|/);
  assert.match(md, /\| src \| 12 \| 5 \| 0\.4167 \| 2 \|/);
  assert.equal(md.split('\n').filter(l => l.startsWith('- f')).length, 50);
  assert.match(md, /and 3 more/);
});
