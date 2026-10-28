import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources } from './helpers/fixture-repo';

const instantiates = (result: AnalyzeResult, from: string): string[] => result.technicalGraph.relations
  .filter(relation => relation.from === from && relation.type === 'INSTANTIATES')
  .map(relation => relation.to)
  .sort();
const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });

/** Analyze a single-file extended snapshot (a trailing comment change makes the diff non-empty). */
function inline(source: string, file = 'src/m.ts'): AnalyzeResult {
  const result = analyzeSources({ base: { [file]: source }, head: { [file]: `${source}// x\n` }, engine: 'extended' });
  assertValid(result);
  return result;
}

const SVC = 'src/services/order-service.ts#';
const LOGGER = 'src/services/logger.ts#';

test('modern-app: new C() gives INSTANTIATES edges to the constructor', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  assert.deepEqual(instantiates(result, `${SVC}OrderService.create`), [`${SVC}OrderService.constructor`]);
  assert.deepEqual(instantiates(result, `${SVC}createDefaultService`), [`${LOGGER}Logger.constructor`, `${SVC}OrderService.constructor`]);
  assert.deepEqual(instantiates(result, `${LOGGER}Logger.create`), [`${LOGGER}Logger.constructor`]);
  // new Map() targets the standard library, which has no entity.
  assert.ok(!result.technicalGraph.relations.some(relation => relation.type === 'INSTANTIATES' && relation.from.endsWith('#<module>')));
  assert.ok(result.technicalGraph.capabilities.relationTypes.includes('INSTANTIATES'));
  assertValid(result);
});

test('modern-app: a constructor change reaches the code that instantiates the class', () => {
  const result = analyzeFixture({
    fixture: 'modern-app',
    engine: 'extended',
    edits: files => ({
      'src/services/logger.ts': files['src/services/logger.ts'].replace(
        'constructor(private readonly prefix: string) {}',
        'constructor(private readonly prefix: string) { this.lines = []; }',
      ),
    }),
  });
  const impact = result.impacts.find(entry => entry.changedEntity.id === `${LOGGER}Logger.constructor`);
  assert.ok(impact, 'constructor is a changed entity');
  const affected = impact.blastRadius.entities.map(entity => entity.id);
  for (const id of [`${LOGGER}Logger.create`, `${SVC}createDefaultService`, `${SVC}OrderService.create`]) assert.ok(affected.includes(id), id);
});

test('checkout instantiating PaymentService gives checkout -> PaymentService.constructor', () => {
  const result = analyzeSources({
    base: {
      'src/services/payment.ts': 'export class PaymentService {\n  constructor(private readonly key: string) {}\n  charge(n: number): number { return n; }\n}\n',
      'src/services/checkout.ts': "import { PaymentService } from './payment';\nexport function checkout(n: number): number {\n  return new PaymentService('k').charge(n);\n}\n",
    },
    head: {
      'src/services/payment.ts': 'export class PaymentService {\n  constructor(private readonly key: string) {}\n  charge(n: number): number { return n; }\n}\n// x\n',
    },
    engine: 'extended',
  });
  assertValid(result);
  assert.deepEqual(instantiates(result, 'src/services/checkout.ts#checkout'), ['src/services/payment.ts#PaymentService.constructor']);
});

test('inherited, overloaded and missing constructors', () => {
  const source = [
    'export class Base { constructor() { void 0; } }',
    'export class Child extends Base { run(): void {} }',
    'export class Plain { run(): void {} }',
    'export class Over {',
    '  constructor(a: string);',
    '  constructor(a: number);',
    '  constructor(a: string | number) { void a; }',
    '}',
    'export function makeChild(): Child { return new Child(); }',
    'export function makePlain(): Plain { return new Plain(); }',
    'export function makeOver(): Over { return new Over(1); }',
    '',
  ].join('\n');
  const result = inline(source);
  assert.deepEqual(instantiates(result, 'src/m.ts#makeChild'), ['src/m.ts#Base.constructor'], 'inherited constructor');
  assert.deepEqual(instantiates(result, 'src/m.ts#makePlain'), [], 'no constructor, no entity, no edge');
  assert.deepEqual(instantiates(result, 'src/m.ts#makeOver'), ['src/m.ts#Over.constructor'], 'overload resolves to the implementation');
});

test('JavaScript constructor function gives an edge to the function', () => {
  const source = 'function Counter() { this.n = 0; }\nfunction make() { return new Counter(); }\nmodule.exports = { make };\n';
  assert.deepEqual(instantiates(inline(source, 'src/m.js'), 'src/m.js#make'), ['src/m.js#Counter']);
});

test('legacy engine emits no INSTANTIATES edges', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'legacy' });
  assert.ok(!result.technicalGraph.relations.some(relation => relation.type === 'INSTANTIATES'));
  assert.deepEqual(result.technicalGraph.capabilities.relationTypes, ['CALLS']);
});
