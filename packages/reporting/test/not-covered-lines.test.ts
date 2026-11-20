import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatImpactReport, notCoveredLines, type ImpactReport, type NotCoveredItem } from '../src/llm-client';

// Phase V (ADR-0011), V-13d: a long "Not covered" list is grouped by file; no name is ever dropped.

const item = (file: string, name: string): NotCoveredItem => ({ entity: `${file}#${name}`, name, file, reason: 'low_score', score: 0.1 });

test('three or fewer items keep one line per change', () => {
  assert.deepEqual(notCoveredLines([item('src/a.ts', 'x'), item('src/a.ts', 'y'), item('src/b.ts', 'z')]), [
    'x in src/a.ts',
    'y in src/a.ts',
    'z in src/b.ts',
  ]);
  assert.deepEqual(notCoveredLines([]), []);
  assert.deepEqual(notCoveredLines(undefined), []);
});

test('a longer list gets one line per file, in first-seen order, naming every change', () => {
  const items = [item('src/a.ts', 'x'), item('src/b.ts', 'z'), item('src/a.ts', 'y'), item('src/a.ts', 'Cls.m'), item('src/c.ts', 'w')];
  const lines = notCoveredLines(items);
  assert.deepEqual(lines, ['src/a.ts: 3 changes (x, y, Cls.m)', 'z in src/b.ts', 'w in src/c.ts']);
  for (const { name } of items) assert.ok(lines.some(line => line.includes(name)), `${name} is still named`);
});

test('a repeated name in the same file is named once', () => {
  const items = [item('src/a.ts', 'x'), item('src/a.ts', 'x'), item('src/a.ts', 'y'), item('src/a.ts', 'z')];
  assert.deepEqual(notCoveredLines(items), ['src/a.ts: 3 changes (x, y, z)']);
});

test('the markdown uses the grouped lines; the data keeps every item', () => {
  const notCovered = ['a', 'b', 'c', 'd'].map(name => item('src/big.ts', name));
  const report: ImpactReport = { summary: 'S.', keyChanges: ['K.'], qaChecks: ['Verify it.'], uncertainty: [], notCovered };
  assert.match(formatImpactReport(report), /Not covered by this report[^\n]*\n- src\/big\.ts: 4 changes \(a, b, c, d\)$/);
  assert.equal(report.notCovered?.length, 4);
});
