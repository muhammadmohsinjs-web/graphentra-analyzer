import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeSources, type Files } from './helpers/fixture-repo';

// P2-9: the ways real repos connect files. Each test proves that edges reach the defining entity
// through the pattern, and that the pattern does not invent edges it should not have.

const CALLER = 'src/caller.ts';
const FMT = 'src/lib/x.ts#fmt';
const RAW = 'src/lib/x.ts#raw';
const UTIL = 'src/util.ts#util';
const SECRET = 'src/internal/secret.ts#secret';

const TSCONFIG = {
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
};
const PACKAGE = { name: 'app', version: '1.0.0', exports: { './util': './src/util.ts' }, imports: { '#internal/*': './src/internal/*.ts' } };

const CALLER_SOURCE = [
  "import { fmt, cooked } from '@/index';",
  "import { util } from 'app/util';",
  "import { secret } from '#internal/secret';",
  "import type { Shape } from './types';",
  "import type { mk } from './types';",
  'export function viaBarrel(): number { return fmt() + cooked(); }',
  'export function viaExports(): number { return util(); }',
  'export function viaImports(): number { return secret(); }',
  'export function viaType(s: Shape): Shape { return s; }',
  'export function viaTypeof(f: typeof mk): void { void f; }',
  "export async function dyn(): Promise<number> { const m = await import('@/lib/x'); return m.fmt(); }",
  'export async function dynVar(n: string): Promise<unknown> { return import(`./lib/${n}`); }',
  '',
].join('\n');

function repo(overrides: Files = {}): Files {
  return {
    'tsconfig.json': JSON.stringify(TSCONFIG),
    'package.json': JSON.stringify(PACKAGE),
    'src/lib/x.ts': 'export function fmt(): number { return 1; }\nexport function raw(): number { return 2; }\n',
    // Nested barrels: src/index.ts re-exports src/lib/index.ts, which re-exports x.ts (one rename on the way).
    'src/lib/index.ts': "export * from './x';\nexport { raw as cooked } from './x';\n",
    'src/index.ts': "export * from './lib';\n",
    'src/util.ts': 'export function util(): number { return 3; }\n',
    'src/internal/secret.ts': 'export function secret(): number { return 4; }\n',
    'src/types.ts': 'export type Shape = { a: number };\nexport function mk(): Shape { return { a: 1 }; }\n',
    [CALLER]: CALLER_SOURCE,
    ...overrides,
  };
}

function analyze(base: Files, head: Files = { 'src/lib/x.ts': `${base['src/lib/x.ts']}// x\n` }): AnalyzeResult {
  const result = analyzeSources({ base, head, engine: 'extended', defaultTsconfig: false });
  assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });
  return result;
}

const callsFrom = (result: AnalyzeResult, from: string): string[] => result.technicalGraph.relations
  .filter(relation => relation.from === from && relation.type === 'CALLS')
  .map(relation => relation.to)
  .sort();

test('barrels: named and star re-exports, nested index.ts, and a renamed re-export reach the defining file', () => {
  const result = analyze(repo());
  assert.deepEqual(callsFrom(result, `${CALLER}#viaBarrel`), [FMT, RAW]);
  const everyTarget = result.technicalGraph.relations.filter(relation => relation.type === 'CALLS').map(relation => relation.to);
  assert.ok(everyTarget.every(id => !id.includes('index.ts')), 'no edge points at a barrel file');
});

test('tsconfig paths: the @/ alias resolves to the real module', () => {
  const result = analyze(repo());
  assert.ok(callsFrom(result, `${CALLER}#dyn`).includes(FMT), 'import("@/lib/x") reaches fmt');
  // Negative control: without the paths mapping the alias does not resolve, so the edge disappears.
  const noPaths = analyze(repo({ 'tsconfig.json': JSON.stringify({ compilerOptions: { ...TSCONFIG.compilerOptions, paths: undefined } }) }));
  assert.deepEqual(callsFrom(noPaths, `${CALLER}#dyn`), [], 'no paths mapping, no edge');
});

test('package.json exports and imports fields resolve inside the repo', () => {
  const result = analyze(repo());
  assert.deepEqual(callsFrom(result, `${CALLER}#viaExports`), [UTIL], 'self-reference through the exports field');
  assert.deepEqual(callsFrom(result, `${CALLER}#viaImports`), [SECRET], 'subpath import through the imports field');
  // Negative control: under classic node resolution, exports and imports are ignored.
  const node10 = analyze(repo({ 'tsconfig.json': JSON.stringify({ compilerOptions: { ...TSCONFIG.compilerOptions, moduleResolution: 'node10' } }) }));
  assert.deepEqual(callsFrom(node10, `${CALLER}#viaExports`), [], 'node10 does not read exports');
  assert.deepEqual(callsFrom(node10, `${CALLER}#viaImports`), [], 'node10 does not read imports');
});

test('import() with a literal specifier gives an edge; with a variable it gives none', () => {
  const result = analyze(repo());
  assert.deepEqual(callsFrom(result, `${CALLER}#dyn`), [FMT]);
  assert.deepEqual(callsFrom(result, `${CALLER}#dynVar`), [], 'variable specifier is a frontier item (P4-2), not an edge');
  assert.deepEqual(result.technicalGraph.relations.filter(relation => relation.from === `${CALLER}#dynVar`), []);
});

test('import type and typeof in type positions give no runtime edge', () => {
  const result = analyze(repo());
  assert.deepEqual(result.technicalGraph.relations.filter(relation => relation.from === `${CALLER}#viaType`), [], 'type-only use');
  assert.deepEqual(result.technicalGraph.relations.filter(relation => relation.from === `${CALLER}#viaTypeof`), [], 'typeof is not a call or a value reference');
});

test('a change in lib/x.ts reaches a caller through 2 barrels and an alias, with a typed path', () => {
  const base = repo();
  const result = analyze(base, { 'src/lib/x.ts': base['src/lib/x.ts'].replace('return 1;', 'return 10;') });
  const impact = result.impacts.find(entry => entry.changedEntity.id === FMT);
  assert.ok(impact, 'fmt is a changed entity');
  const viaBarrel = impact.blastRadius.paths.find(entry => entry.target.id === `${CALLER}#viaBarrel`);
  assert.ok(viaBarrel, 'viaBarrel is affected');
  assert.deepEqual(viaBarrel.path.map(entity => entity.id), [FMT, `${CALLER}#viaBarrel`]);
  assert.ok(impact.blastRadius.paths.some(entry => entry.target.id === `${CALLER}#dyn`), 'dynamic import is affected');
});

test('a change in util.ts reaches the caller through the package exports field', () => {
  const base = repo();
  const result = analyze(base, { 'src/util.ts': base['src/util.ts'].replace('return 3;', 'return 30;') });
  const impact = result.impacts.find(entry => entry.changedEntity.id === UTIL);
  assert.ok(impact, 'util is a changed entity');
  assert.ok(impact.blastRadius.paths.some(entry => entry.target.id === `${CALLER}#viaExports`));
});
