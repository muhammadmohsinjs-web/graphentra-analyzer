import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult, Entity } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources, replaceOnce } from './helpers/fixture-repo';

const byId = (result: AnalyzeResult): Map<string, Entity> => new Map(result.technicalGraph.entities.map(entity => [entity.id, entity]));
const changedIds = (result: AnalyzeResult): string[] => result.changedEntities.map(changed => changed.entity.id);
const hasEdge = (result: AnalyzeResult, from: string, to: string): boolean =>
  result.technicalGraph.relations.some(relation => relation.from === from && relation.to === to && relation.type === 'CALLS');
const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });
const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code);

const formatEdit = (files: Record<string, string>) => ({
  'src/utils/format.ts': replaceOnce(files['src/utils/format.ts']!, 'toFixed(2)', 'toFixed(3)'),
});

test('extended: modern-app variable-bound, nested and default-exported functions are entities', () => {
  const extended = byId(analyzeFixture({ fixture: 'modern-app', engine: 'extended' }));
  for (const id of [
    'src/utils/format.ts#formatPrice', 'src/utils/format.ts#pad', 'src/utils/format.ts#slugify',
    'src/utils/math.ts#sum', 'src/utils/math.ts#sum>add', 'src/utils/math.ts#orderTotal',
  ]) assert.ok(extended.has(id), `missing ${id}`);
  const slugify = extended.get('src/utils/format.ts#slugify')!;
  assert.equal(slugify.exportName, 'default');
  assert.equal(slugify.exported, true);
  assert.equal(extended.get('src/utils/math.ts#sum>add')!.exported, undefined);
  assert.equal(extended.get('src/utils/math.ts#sum')!.exported, true);

  const legacy = byId(analyzeFixture({ fixture: 'modern-app', engine: 'legacy' }));
  for (const id of ['src/utils/format.ts#formatPrice', 'src/utils/format.ts#pad', 'src/utils/math.ts#sum', 'src/utils/math.ts#orderTotal', 'src/utils/math.ts#sum>add']) {
    assert.ok(!legacy.has(id), `legacy must not have ${id}`);
  }
  for (const id of ['src/utils/format.ts#slugify', 'src/utils/math.ts#clamp', 'src/utils/math.ts#add']) assert.ok(legacy.has(id), `legacy missing ${id}`);
});

test('extended: a formatPrice body edit is a completed change; legacy sees no supported change', () => {
  const extended = analyzeFixture({ fixture: 'modern-app', engine: 'extended', edits: formatEdit });
  assert.equal(extended.outcome, 'completed');
  assert.ok(changedIds(extended).includes('src/utils/format.ts#formatPrice'));
  assertValid(extended);
  const legacy = analyzeFixture({ fixture: 'modern-app', engine: 'legacy', edits: formatEdit });
  assert.equal(legacy.outcome, 'no_supported_changes');
});

test('extended: multi-declarator statements use VariableDeclaration ranges', () => {
  const source = 'const a = () => 1,\n  b = () => 2;\nexport const c = () => 3;\n';
  const result = analyzeSources({ base: { 'src/m.ts': source }, head: { 'src/m.ts': `${source}// x\n` }, engine: 'extended' });
  const entities = byId(result);
  assert.deepEqual([entities.get('src/m.ts#a')!.startLine, entities.get('src/m.ts#a')!.endLine], [1, 1]);
  assert.deepEqual([entities.get('src/m.ts#b')!.startLine, entities.get('src/m.ts#b')!.endLine], [2, 2]);
  assert.deepEqual([entities.get('src/m.ts#c')!.startLine, entities.get('src/m.ts#c')!.endLine], [3, 3]);
  assertValid(result);
});

test('extended: wrapper calls (useCallback, memo, React.memo, forwardRef) are unwrapped', () => {
  const source = [
    'declare function useCallback<T>(fn: T, deps: unknown[]): T;',
    'declare function useMemo<T>(fn: () => T, deps: unknown[]): T;',
    'declare function memo<T>(fn: T): T;',
    'declare const React: { memo<T>(fn: T): T };',
    'export const onClick = useCallback(() => 1, []);',
    'export const value = useMemo(() => 2, []);',
    'export const Wrapped = memo(() => 3);',
    'export const Wrapped2 = React.memo(function () { return 4; });',
    'export const notWrapped = memo(someValue as never);',
    'declare const someValue: unknown;',
    '',
  ].join('\n');
  const result = analyzeSources({ base: { 'src/w.ts': source }, head: { 'src/w.ts': `${source}// x\n` }, engine: 'extended' });
  const entities = byId(result);
  for (const name of ['onClick', 'value', 'Wrapped', 'Wrapped2']) assert.ok(entities.has(`src/w.ts#${name}`), name);
  assert.ok(!entities.has('src/w.ts#notWrapped'));
  assertValid(result);
});

test('overloads: legacy throws AMBIGUOUS_ENTITY_ID, extended yields one entity spanning all lines', () => {
  const source = [
    'export function f(a: string): string;',
    'export function f(a: number): number;',
    'export function f(a: any): any {',
    '  return a;',
    '}',
    'declare function ambient(): void;',
    '',
  ].join('\n');
  const edited = source.replace('return a;', 'return a + a;');
  const run = (engine: 'legacy' | 'extended') =>
    analyzeSources({ base: { 'src/o.ts': source }, head: { 'src/o.ts': edited }, engine });
  throwsCode(() => run('legacy'), 'AMBIGUOUS_ENTITY_ID');
  const result = run('extended');
  const entities = result.technicalGraph.entities.filter(entity => entity.file === 'src/o.ts');
  assert.equal(entities.length, 1);
  assert.deepEqual([entities[0]!.id, entities[0]!.startLine, entities[0]!.endLine], ['src/o.ts#f', 1, 5]);
  assert.equal(result.outcome, 'completed');
  assertValid(result);
});

test('duplicates: extended disambiguates with ~N and an info diagnostic, legacy throws', () => {
  const source = 'export function g(x: boolean) {\n  if (x) {\n    function f() { return 1; }\n    return f();\n  } else {\n    function f() { return 2; }\n    return f();\n  }\n}\n';
  const run = (engine: 'legacy' | 'extended') =>
    analyzeSources({ base: { 'src/d.ts': source }, head: { 'src/d.ts': source.replace('return 2', 'return 3') }, engine });
  throwsCode(() => run('legacy'), 'AMBIGUOUS_ENTITY_ID');
  const result = run('extended');
  const ids = result.technicalGraph.entities.map(entity => entity.id);
  assert.ok(ids.includes('src/d.ts#g>f') && ids.includes('src/d.ts#g>f~2'));
  const diagnostic = result.diagnostics.find(item => item.code === 'DUPLICATE_ENTITY_ID_DISAMBIGUATED');
  assert.ok(diagnostic);
  assert.equal(diagnostic.severity, 'info');
  assert.equal(diagnostic.entityId, 'src/d.ts#g>f~2');
  assertValid(result);
});

test('extended: default imports create CALLS edges to named and anonymous default exports', () => {
  const cases: Array<[string, string]> = [
    ['export default function slugify(s: string) { return s; }\n', 'src/format.ts#slugify'],
    ['export default function (s: string) { return s; }\n', 'src/format.ts#default'],
    ['export default (s: string) => s;\n', 'src/format.ts#default'],
  ];
  for (const [format, target] of cases) {
    const app = "import fmt from './format';\nexport function run() { return fmt('x'); }\n";
    const result = analyzeSources({
      base: { 'src/format.ts': format, 'src/app.ts': app },
      head: { 'src/app.ts': `${app}// x\n` },
      engine: 'extended',
    });
    const entity = byId(result).get(target);
    assert.ok(entity, `missing ${target}`);
    assert.equal(entity.exportName, 'default');
    assert.equal(entity.exported, true);
    assert.ok(hasEdge(result, 'src/app.ts#run', target), `missing edge to ${target}`);
    assertValid(result);
  }
});
