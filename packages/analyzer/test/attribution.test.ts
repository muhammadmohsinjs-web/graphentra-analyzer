import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedEntity, ChangedFile, DiffLine, Entity } from '../src/contracts';
import { computeAttribution, validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, replaceOnce } from './helpers/fixture-repo';

const MATH = 'src/utils/math.ts';

function file(lines: Array<[DiffLine['kind'], string]>): ChangedFile {
  const diffLines = lines.map(([kind, code], i) => ({ kind, code, oldLine: i + 1, newLine: i + 1 }));
  return { file: 'a.ts', changedLines: [], addedCode: [], removedCode: [], diff: '', hunks: [{ lines: diffLines }] };
}

function changed(kind: Entity['kind'], addedCode: string[], removedCode: string[] = []): ChangedEntity {
  return {
    entity: { id: `a.ts#${kind}`, kind, name: kind, file: 'a.ts', startLine: 1, endLine: 9 } as Entity,
    change: { file: 'a.ts', changedLines: [], addedCode, removedCode, diff: '' },
  };
}

test('computeAttribution: blank lines are excluded everywhere', () => {
  const files = [file([['+', 'a'], ['+', '   '], ['-', ''], [' ', 'ctx'], ['-', 'b']])];
  const result = computeAttribution(files, [changed('function', ['a', '  ', ''], ['b'])]);
  assert.deepEqual(result, { total: 2, code: 2, module: 0, unattributed: 0, ratio: 1 });
});

test('computeAttribution: module and code entities are counted separately', () => {
  const files = [file([['+', 'a'], ['+', 'b'], ['+', 'c'], ['-', 'd']])];
  const result = computeAttribution(files, [changed('function', ['a']), changed('module', ['b'], ['d'])]);
  assert.deepEqual(result, { total: 4, code: 1, module: 2, unattributed: 1, ratio: 0.25 });
});

test('computeAttribution: ratio is rounded to 4 decimal places', () => {
  const files = [file([['+', 'a'], ['+', 'b'], ['+', 'c']])];
  assert.equal(computeAttribution(files, [changed('function', ['a'])]).ratio, 0.3333);
  assert.equal(computeAttribution(files, [changed('function', ['a', 'b'])]).ratio, 0.6667);
});

test('computeAttribution: total = 0 gives ratio 1', () => {
  assert.deepEqual(computeAttribution([], []), { total: 0, code: 0, module: 0, unattributed: 0, ratio: 1 });
});

test('computeAttribution: code + module <= total on varied inputs', () => {
  for (let n = 0; n < 6; n++) {
    const lines: Array<[DiffLine['kind'], string]> = Array.from({ length: n * 2 }, (_, i) => [i % 2 ? '-' : '+', i % 3 ? `x${i}` : ' ']);
    const owned = lines.filter(([, code]) => code.trim()).map(([, code]) => code);
    for (let split = 0; split <= owned.length; split++) {
      const result = computeAttribution([file(lines)], [changed('function', owned.slice(0, split)), changed('module', owned.slice(split))]);
      assert.ok(result.code + result.module <= result.total);
      assert.ok(result.unattributed >= 0);
    }
  }
});

test('extended: an edit inside a function body is fully attributed', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended',
    edits: files => ({ [MATH]: replaceOnce(files[MATH], 'return Math.min(Math.max(n, min), max);', 'return Math.max(Math.min(n, max), min);') }) });
  const diagnostic = result.diagnostics.find(item => item.code === 'ATTRIBUTED_LINE_RATIO');
  assert.ok(diagnostic);
  assert.equal(result.diagnostics.at(-1), diagnostic);
  assert.equal(result.attribution?.ratio, 1);
  assert.match(diagnostic.message, /ratio 1\.0000\)/);
  assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });
});

test('extended: an edit to an import line is module-level', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended',
    edits: files => ({ [MATH]: replaceOnce(files[MATH], "import { Order } from '../types';", "import type { Order } from '../types';") }) });
  assert.equal(result.attribution?.module, 2);
  assert.equal(result.attribution?.code, 0);
  assert.equal(result.attribution?.unattributed, 0);
});

test('legacy: no attribution diagnostic and no attribution field', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'legacy',
    edits: files => ({ [MATH]: replaceOnce(files[MATH], 'return a + b;', 'return b + a;') }) });
  assert.ok(!result.diagnostics.some(item => item.code === 'ATTRIBUTED_LINE_RATIO'));
  assert.equal(result.attribution, undefined);
});
