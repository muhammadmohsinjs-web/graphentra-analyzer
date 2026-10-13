import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources } from './helpers/fixture-repo';

const kinds = (result: AnalyzeResult): Map<string, string> => new Map(result.technicalGraph.entities.map(entity => [entity.id, entity.kind]));
const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });

const inline = (file: string, source: string): Map<string, string> => {
  const result = analyzeSources({ base: { [file]: source }, head: { [file]: `${source}// x\n` }, engine: 'extended' });
  assertValid(result);
  return kinds(result);
};

test('extended: modern-app React components are tagged component', () => {
  const k = kinds(analyzeFixture({ fixture: 'modern-app', engine: 'extended' }));
  for (const id of [
    'src/components/OrderList.tsx#OrderList',
    'src/components/OrderRow.tsx#OrderRow',
    'src/components/Summary.tsx#Summary',
    'src/app/orders/page.tsx#OrdersPage',
  ]) assert.equal(k.get(id), 'component', id);
  assert.equal(k.get('src/components/OrderList.tsx#OrderList>renderRow'), 'function');
  assert.equal(k.get('src/components/OrderList.tsx#OrderList>handleClear'), 'function');
  assert.equal(k.get('src/app/orders/page.tsx#OrdersPage>loadOrders'), 'function');
  for (const [id, kind] of k) if (/#use[A-Z]/.test(id)) assert.equal(kind, 'function', id);
});

test('extended: inline component heuristic cases', () => {
  const k = inline('src/c.tsx', [
    'declare function memo<T>(fn: T): T;',
    'declare function forwardRef<T>(fn: T): T;',
    'export function Helper() { return 1; }',
    'export function lower() { return <div />; }',
    'export function useThing() { return <div />; }',
    'export const Card = memo(() => <div />);',
    'export const Btn = forwardRef((p: unknown, r: unknown) => <button />);',
    'export function Maybe(p: { x: boolean }) { if (p.x) return null; return <>hi</>; }',
    'export default function () { return <div />; }',
    '',
  ].join('\n'));
  assert.equal(k.get('src/c.tsx#Helper'), 'function');
  assert.equal(k.get('src/c.tsx#lower'), 'function');
  assert.equal(k.get('src/c.tsx#useThing'), 'function');
  assert.equal(k.get('src/c.tsx#Card'), 'component');
  assert.equal(k.get('src/c.tsx#Btn'), 'component');
  assert.equal(k.get('src/c.tsx#Maybe'), 'component');
  assert.equal(k.get('src/c.tsx#default'), 'component');
});

test('extended: anonymous default export without JSX and PascalCase in .ts stay function', () => {
  const plain = inline('src/d.tsx', 'export default function () { return 1; }\n');
  assert.equal(plain.get('src/d.tsx#default'), 'function');
  const plainTs = inline('src/e.ts', 'export function Widget() { return 1; }\n');
  assert.equal(plainTs.get('src/e.ts#Widget'), 'function');
});

test('extended: an edit inside OrderList attributes to the component entity', () => {
  const result = analyzeFixture({
    fixture: 'modern-app',
    engine: 'extended',
    edits: f => ({ 'src/components/OrderList.tsx': f['src/components/OrderList.tsx']!.replace('Clear</button>', 'Reset</button>') }),
  });
  assert.equal(result.outcome, 'completed');
  const changed = result.changedEntities.find(c => c.entity.id === 'src/components/OrderList.tsx#OrderList');
  assert.ok(changed);
  assert.equal(changed.entity.kind, 'component');
  assertValid(result);
});

test('extended: the legacy no_supported_changes component-edit golden scenario completes', () => {
  const edits = (f: Record<string, string>) => ({
    'src/components/OrderList.tsx': f['src/components/OrderList.tsx']! + '\n// touched\nconst touched = () => 1;\n',
  });
  const legacy = analyzeFixture({ fixture: 'modern-app', engine: 'legacy', edits });
  assert.equal(legacy.outcome, 'no_supported_changes');
  const extended = analyzeFixture({ fixture: 'modern-app', engine: 'extended', edits });
  assert.equal(extended.outcome, 'completed');
  assertValid(extended);
});
