import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile, Entity } from '../src/contracts';
import { findChangedEntities } from '../src/impact';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeSources } from './helpers/fixture-repo';

test('extended: a syntax error yields FILE_PARSE_ERRORS, keeps parsable entities and validates', () => {
  const broken = 'export function good() { return 1; }\nexport const f = () => { if ( }\n';
  const result = analyzeSources({
    base: { 'src/a.ts': 'export function good() { return 0; }\n' },
    head: { 'src/a.ts': broken },
    engine: 'extended',
  });
  const parse = result.diagnostics.filter(item => item.code === 'FILE_PARSE_ERRORS');
  assert.equal(parse.length, 1);
  assert.equal(parse[0]!.file, 'src/a.ts');
  assert.match(parse[0]!.message, /^\d+ syntax error\(s\); entities were collected from the parts that parse\.$/);
  assert.ok(result.technicalGraph.entities.some(entity => entity.id === 'src/a.ts#good'));
  assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });
});

test('legacy: no FILE_PARSE_ERRORS diagnostics are emitted', () => {
  const result = analyzeSources({
    base: { 'src/a.ts': 'export function good() { return 0; }\n' },
    head: { 'src/a.ts': 'export function good() { return 1; }\nconst f = () => { if ( }\n' },
    engine: 'legacy',
  });
  assert.equal(result.diagnostics.some(item => item.code === 'FILE_PARSE_ERRORS'), false);
});

const entity: Entity = {
  id: 'src/a.ts#f', kind: 'function', name: 'f', file: 'src/a.ts', startLine: 1, endLine: 3,
  language: 'typescript',
};
const changedFile: ChangedFile = {
  file: 'src/a.ts', oldFile: 'src/a.ts', changedLines: [2], addedCode: ['  return 2;'], removedCode: ['  return 1;'],
  diff: '',
  hunks: [{ lines: [
    { kind: ' ', code: 'function f() {', oldLine: 1, newLine: 1 },
    { kind: '-', code: '  return 1;', oldLine: 2, newLine: 0 },
    { kind: '+', code: '  return 2;', oldLine: 0, newLine: 2 },
    { kind: ' ', code: '}', oldLine: 3, newLine: 3 },
  ] }],
};
const throwingBaseline = (): string => { throw new Error('/abs/path/secret'); };

test('extended: a failing baseline reports BASELINE_ANALYSIS_FAILED and still reports the change', () => {
  const result = findChangedEntities({
    changedFiles: [changedFile], entities: [entity], getBaselineSource: throwingBaseline,
  }, 'extended');
  assert.deepEqual(result.extraDiagnostics, [{
    code: 'BASELINE_ANALYSIS_FAILED',
    severity: 'warning',
    file: 'src/a.ts',
    message: 'Baseline entity collection failed (Error); removed-code evidence is unavailable for this file.',
  }]);
  assert.equal(result.changedEntities.length, 1);
  assert.deepEqual(result.changedEntities[0]!.change.removedCode, []);
  assert.deepEqual(result.changedEntities[0]!.change.addedCode, ['  return 2;']);
});

test('legacy: a throwing getBaselineSource still throws', () => {
  assert.throws(() => findChangedEntities({
    changedFiles: [changedFile], entities: [entity], getBaselineSource: throwingBaseline,
  }, 'legacy'), /secret/);
});
