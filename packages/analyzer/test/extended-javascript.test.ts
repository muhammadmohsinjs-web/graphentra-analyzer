import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult, Entity } from '../src/contracts';
import { computeDeterministicEvidenceIdentity, validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources, replaceOnce } from './helpers/fixture-repo';

const byId = (result: AnalyzeResult): Map<string, Entity> => new Map(result.technicalGraph.entities.map(entity => [entity.id, entity]));
const changedIds = (result: AnalyzeResult): string[] => result.changedEntities.map(changed => changed.entity.id);
const hasEdge = (result: AnalyzeResult, from: string, to: string): boolean =>
  result.technicalGraph.relations.some(relation => relation.from === from && relation.to === to && relation.type === 'CALLS');
const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });

const CJS = 'src/legacy/cjs-module.js';
const jsEdit = (files: Record<string, string>) => ({ [CJS]: replaceOnce(files[CJS]!, '`${last}, ${first}`', '`${last} ${first}`') });

test('extended: modern-app JavaScript files produce javascript entities', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  const entities = byId(result);
  assert.equal(entities.get(`${CJS}#formatName`)?.language, 'javascript');
  assert.equal(entities.get(`${CJS}#shout`)?.language, 'javascript');
  assert.equal(entities.get(`${CJS}#shout`)?.exported, true);
  assert.ok(['function', 'component'].includes(entities.get('src/legacy/Badge.jsx#Badge')?.kind ?? ''));
  assert.equal(entities.get('src/legacy/Badge.jsx#Badge')?.language, 'javascript');
  for (const file of [CJS, 'src/legacy/esm.mjs', 'src/legacy/Badge.jsx', 'src/legacy/use-legacy.js']) {
    const module = entities.get(`${file}#<module>`);
    assert.equal(module?.kind, 'module', `missing module for ${file}`);
    assert.equal(module?.language, 'javascript');
  }
  assert.equal(entities.get('src/utils/format.ts#formatPrice')?.language, 'typescript');
  assert.equal(entities.get('src/utils/format.ts#<module>')?.language, 'typescript');
  assertValid(result);
});

test('extended: a JS function body edit is completed; legacy reports no_supported_changes', () => {
  const extended = analyzeFixture({ fixture: 'modern-app', engine: 'extended', edits: jsEdit });
  assert.equal(extended.outcome, 'completed');
  assert.ok(changedIds(extended).includes(`${CJS}#formatName`));
  assertValid(extended);
  const legacy = analyzeFixture({ fixture: 'modern-app', engine: 'legacy', edits: jsEdit });
  assert.equal(legacy.outcome, 'no_supported_changes');
  assert.ok(legacy.evidence.diagnostics.some(d => d.code === 'OUTSIDE_SUPPORTED_SCOPE'));
  assert.ok(![...byId(legacy).keys()].some(id => id.startsWith('src/legacy/')));
});

test('extended: ESM import and CommonJS require edges resolve', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  assert.ok(hasEdge(result, 'src/legacy/esm.mjs#describePrice', 'src/utils/format.ts#formatPrice'));
  // Destructured require() of a CommonJS module and of an .mjs module follows aliases to the declared function.
  assert.ok(hasEdge(result, 'src/legacy/use-legacy.js#greet', `${CJS}#formatName`));
  assert.ok(hasEdge(result, 'src/legacy/use-legacy.js#greet', 'src/legacy/esm.mjs#describePrice'));
});

test('extended: module.exports = { fn } shorthand resolves through require()', () => {
  const result = analyzeSources({
    base: {
      'src/lib.js': 'function formatName(a) { return a; }\nmodule.exports = { formatName };\n',
      'src/use.js': "const { formatName } = require('./lib');\nfunction go() { return formatName('x'); }\nmodule.exports = { go };\n",
    },
    head: { 'src/lib.js': 'function formatName(a) { return a + 1; }\nmodule.exports = { formatName };\n' },
    engine: 'extended',
  });
  assert.equal(result.outcome, 'completed');
  assert.ok(hasEdge(result, 'src/use.js#go', 'src/lib.js#formatName'));
});

test('extended: *.min.js is ignored', () => {
  const result = analyzeSources({
    base: { 'src/a.js': 'function a() { return 1; }\n', 'src/vendor.min.js': 'function m(){return 1}\n' },
    head: { 'src/a.js': 'function a() { return 2; }\n', 'src/vendor.min.js': 'function m(){return 2}\n' },
    engine: 'extended',
  });
  const ids = [...byId(result).keys()];
  assert.ok(ids.includes('src/a.js#a'));
  assert.ok(!ids.some(id => id.includes('min.js')));
  assert.ok(result.evidence.diagnostics.some(d => d.code === 'OUTSIDE_SUPPORTED_SCOPE'));
});

test('extended: a jsconfig.json-only repo is analyzed', () => {
  const src = 'export function twice(n) { return n * 2; }\nexport const call = () => twice(2);\n';
  const result = analyzeSources({
    base: { 'jsconfig.json': JSON.stringify({ compilerOptions: { module: 'commonjs', target: 'es2022' } }), 'src/a.js': src },
    head: { 'src/a.js': src.replace('n * 2', 'n * 3') },
    engine: 'extended',
    defaultTsconfig: false,
  });
  assert.equal(result.outcome, 'completed');
  assert.ok(changedIds(result).includes('src/a.js#twice'));
  assert.ok(hasEdge(result, 'src/a.js#call', 'src/a.js#twice'));
  assertValid(result);
});

test('extended: determinism across runs', () => {
  const a = analyzeFixture({ fixture: 'modern-app', engine: 'extended', edits: jsEdit });
  const b = analyzeFixture({ fixture: 'modern-app', engine: 'extended', edits: jsEdit });
  assert.equal(computeDeterministicEvidenceIdentity(a.evidence), computeDeterministicEvidenceIdentity(b.evidence));
});
