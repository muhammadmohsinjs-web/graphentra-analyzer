import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources } from './helpers/fixture-repo';

type EdgeType = 'RENDERS' | 'REFERENCES';
const targets = (result: AnalyzeResult, type: EdgeType, from: string): string[] => result.technicalGraph.relations
  .filter(relation => relation.from === from && relation.type === type)
  .map(relation => relation.to)
  .sort();
const hasEdge = (result: AnalyzeResult, type: EdgeType, from: string, to: string): boolean => targets(result, type, from).includes(to);
const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });

/** Analyze a single-file extended snapshot (a trailing comment change makes the diff non-empty). */
function inline(source: string, file = 'src/m.tsx'): AnalyzeResult {
  const result = analyzeSources({ base: { [file]: source }, head: { [file]: `${source}// x\n` }, engine: 'extended' });
  assertValid(result);
  return result;
}

const LIST = 'src/components/OrderList.tsx#OrderList';
const ROW = 'src/components/OrderRow.tsx#OrderRow';
const PAGE = 'src/app/orders/page.tsx#OrdersPage';
const SUMMARY = 'src/components/Summary.tsx#Summary';

test('modern-app: JSX elements give RENDERS edges, intrinsic elements give none', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  assert.deepEqual(targets(result, 'RENDERS', PAGE), ['src/components/OrderList.tsx#OrderList', SUMMARY]);
  assert.deepEqual(targets(result, 'RENDERS', `${LIST}>renderRow`), [ROW]);
  assert.deepEqual(targets(result, 'RENDERS', LIST), [SUMMARY]);
  assert.ok(result.technicalGraph.relations.filter(relation => relation.type === 'RENDERS').every(relation => relation.to !== relation.from));
  assertValid(result);
});

test('modern-app: changing OrderRow reaches OrdersPage through RENDERS and REFERENCES', () => {
  const result = analyzeFixture({
    fixture: 'modern-app',
    engine: 'extended',
    edits: files => ({ 'src/components/OrderRow.tsx': files['src/components/OrderRow.tsx'].replace('"order-row"', '"order-row-x"') }),
  });
  assertValid(result);
  const impact = result.impacts.find(entry => entry.changedEntity.id === ROW);
  assert.ok(impact, 'OrderRow is a changed entity');
  const toPage = impact.blastRadius.paths.find(entry => entry.target.id === PAGE);
  assert.ok(toPage, 'OrdersPage is affected');
  assert.deepEqual(toPage.path.map(entity => entity.id), [ROW, `${LIST}>renderRow`, LIST, PAGE]);
});

test('modern-app: function values give REFERENCES edges', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  assert.deepEqual(targets(result, 'REFERENCES', LIST), [`${LIST}>handleClear`, `${LIST}>renderRow`]);
  assert.deepEqual(targets(result, 'REFERENCES', 'src/server/app.ts#buildApp'), [
    'src/server/app.ts#logRequest',
    'src/server/handlers.ts#createOrder',
    'src/server/handlers.ts#health',
    'src/server/handlers.ts#listOrders',
  ]);
});

test('modern-app: getter reads and useMemo values are not function references', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  const bad = result.technicalGraph.relations.filter(relation => relation.type === 'REFERENCES'
    && (relation.to.endsWith('>total') || relation.to.endsWith('>count') || relation.to.endsWith('.get count')));
  assert.deepEqual(bad, []);
});

test('REFERENCES positions: JSX attribute, argument, property, shorthand, assignment, return', () => {
  const source = [
    'declare function run(fn: () => void): void;',
    'function handle(): void {}',
    'export function viaAttr() { return <button onClick={handle} />; }',
    'export function viaArg() { run(handle); }',
    'export function viaProp() { return { handler: handle }; }',
    'export function viaShorthand() { return { handle }; }',
    'export function viaAssign() { const f = handle; return f; }',
    'export function viaReturn() { return handle; }',
    'export function viaCast() { run(handle as () => void); }',
    'export function viaCall() { handle(); }',
    '',
  ].join('\n');
  const result = inline(source);
  for (const name of ['viaAttr', 'viaArg', 'viaProp', 'viaShorthand', 'viaAssign', 'viaReturn', 'viaCast']) {
    assert.ok(hasEdge(result, 'REFERENCES', `src/m.tsx#${name}`, 'src/m.tsx#handle'), name);
  }
  assert.deepEqual(targets(result, 'REFERENCES', 'src/m.tsx#viaCall'), [], 'a call is CALLS, not REFERENCES');
});

test('REFERENCES: a shadowed local with the same name gives no edge', () => {
  const source = [
    'declare function run(fn: () => void): void;',
    'function handle(): void {}',
    'export function shadow(handle: () => void) { run(handle); }',
    'export function shadowLocal() { const handle = () => 1; run(handle); }',
    '',
  ].join('\n');
  const result = inline(source);
  assert.ok(!hasEdge(result, 'REFERENCES', 'src/m.tsx#shadow', 'src/m.tsx#handle'), 'parameter shadows');
  assert.ok(!hasEdge(result, 'REFERENCES', 'src/m.tsx#shadowLocal', 'src/m.tsx#handle'), 'local shadows');
});

test('REFERENCES: self-reference, export aliasing and imports give no edge', () => {
  const result = analyzeSources({
    base: {
      'src/a.ts': 'export function tick(): void { setTimeout(tick, 1); }\nfunction other(): void {}\nexport { other as renamed };\n',
      'src/b.ts': "import { renamed } from './a';\nexport function use(): void { setTimeout(renamed, 1); }\n",
    },
    head: { 'src/a.ts': 'export function tick(): void { setTimeout(tick, 1); }\nfunction other(): void {}\nexport { other as renamed };\n// x\n' },
    engine: 'extended',
  });
  assertValid(result);
  assert.deepEqual(targets(result, 'REFERENCES', 'src/a.ts#tick'), [], 'recursion is noise');
  assert.deepEqual(targets(result, 'REFERENCES', 'src/a.ts#<module>'), [], 'export { x as y } is aliasing');
  assert.deepEqual(targets(result, 'REFERENCES', 'src/b.ts#use'), ['src/a.ts#other'], 'alias resolves to the real entity');
});

test('RENDERS: wrapped, namespaced and aliased components', () => {
  const result = analyzeSources({
    base: {
      'src/row.tsx': 'const RowImpl = () => <li />;\nexport const Row = RowImpl;\nexport const Plain = () => <li />;\n',
      'src/page.tsx': [
        "import { Row as Aliased, Plain } from './row';",
        "import * as ui from './row';",
        'export const Page = () => <ul><Aliased /><ui.Plain /><div /></ul>;',
        'export const Other = () => <Plain />;',
        '',
      ].join('\n'),
    },
    head: { 'src/row.tsx': 'const RowImpl = () => <li />;\nexport const Row = RowImpl;\nexport const Plain = () => <li />;\n// x\n' },
    engine: 'extended',
  });
  assertValid(result);
  const rendered = targets(result, 'RENDERS', 'src/page.tsx#Page');
  assert.ok(rendered.includes('src/row.tsx#Plain'), 'namespace member');
  assert.ok(!rendered.some(id => id.includes('div')), 'intrinsic element');
  assert.deepEqual(targets(result, 'RENDERS', 'src/page.tsx#Other'), ['src/row.tsx#Plain']);
});

test('legacy engine emits no RENDERS or REFERENCES edges', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'legacy' });
  assert.ok(!result.technicalGraph.relations.some(relation => relation.type !== 'CALLS'));
});
