import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult, Entity } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources } from './helpers/fixture-repo';

const byId = (result: AnalyzeResult): Map<string, Entity> => new Map(result.technicalGraph.entities.map(entity => [entity.id, entity]));
const hasEdge = (result: AnalyzeResult, from: string, to: string): boolean =>
  result.technicalGraph.relations.some(relation => relation.from === from && relation.to === to && relation.type === 'CALLS');
const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });

/** Analyze a single-file extended snapshot (a trailing comment change makes the diff non-empty). */
function inline(source: string, file = 'src/m.ts'): AnalyzeResult {
  const result = analyzeSources({ base: { [file]: source }, head: { [file]: `${source}// x\n` }, engine: 'extended' });
  assertValid(result);
  return result;
}

const SVC = 'src/services/order-service.ts#';

test('modern-app: class and object-literal methods are method entities', () => {
  const entities = byId(analyzeFixture({ fixture: 'modern-app', engine: 'extended' }));
  for (const name of ['constructor', 'create', 'add', 'total', 'get count', 'record']) {
    const entity = entities.get(`${SVC}OrderService.${name}`);
    assert.ok(entity, `missing OrderService.${name}`);
    assert.equal(entity.kind, 'method');
    assert.equal(entity.container, 'OrderService');
  }
  assert.ok(!entities.has(`${SVC}OrderService`), 'class is not an entity');
  for (const name of ['inventory.reserve', 'inventory.release']) assert.ok(entities.has(`src/services/inventory.ts#${name}`), name);
  assert.ok(!entities.has('src/services/inventory.ts#inventory'));
  for (const name of ['Logger.info', 'Logger.create', 'Logger.constructor', 'Logger.get lineCount']) {
    assert.ok(entities.has(`src/services/logger.ts#${name}`), name);
  }
});

test('modern-app: method calls resolve to CALLS edges', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  assert.ok(hasEdge(result, `${SVC}OrderService.add`,`${SVC}OrderService.record`), 'this.record');
  // The fixture's inventory.release -> inventory.reserve call has no edge: `inventory` is self-referential,
  // so the checker types it `any` (TS7022) and no symbol resolves. The inline test below covers a resolvable shape.
  assert.ok(hasEdge(result, `${SVC}OrderService.record`, 'src/services/logger.ts#Logger.info'), 'this.logger.info');
  assert.ok(hasEdge(result, `${SVC}OrderService.create`, 'src/services/logger.ts#Logger.create'), 'static call');
});

test('object-literal method calling a sibling through this gives an edge', () => {
  const source = [
    'export const inv = {',
    '  reserve(n: number): number { return n; },',
    '  release(n: number): number { return this.reserve(n); },',
    '};',
    '',
  ].join('\n');

  assert.ok(hasEdge(inline(source), 'src/m.ts#inv.release', 'src/m.ts#inv.reserve'));
});

test('modern-app: every method entity has a container and a dotted name', () => {
  const result = analyzeFixture({ fixture: 'modern-app', engine: 'extended' });
  const methods = result.technicalGraph.entities.filter(entity => entity.kind === 'method');
  assert.ok(methods.length > 0);
  for (const entity of methods) {
    assert.ok(entity.container && entity.container.length > 0, entity.id);
    assert.ok(entity.id.slice(entity.id.indexOf('#') + 1).includes('.'), entity.id);
  }
  assertValid(result);
});

test('class-typed receiver call gives an edge; interface-typed receiver gives none', () => {
  const source = [
    'export class Svc { run(): number { return 1; } }',
    'export interface Runner { run(): number }',
    'export function viaClass(): number { const svc = new Svc(); return svc.run(); }',
    'export function viaInterface(r: Runner): number { return r.run(); }',
    '',
  ].join('\n');
  const result = inline(source);
  assert.ok(hasEdge(result, 'src/m.ts#viaClass', 'src/m.ts#Svc.run'));
  assert.ok(!result.technicalGraph.relations.some(relation => relation.from === 'src/m.ts#viaInterface' && relation.type === 'CALLS'));
});

test('inline: accessors, constructors, static, private, computed, symbols, abstract, overloads', () => {
  const source = [
    'export abstract class C {',
    '  #p = 1;',
    '  get x(): number { return 1; }',
    '  set x(v: number) { this.#p = v; }',
    '  constructor() {}',
    '  static make(): C { return null as never; }',
    '  #priv() { return 1; }',
    '  ["computed"]() {}',
    '  [Symbol.iterator]() { return [][Symbol.iterator](); }',
    '  abstract nope(): void;',
    '  over(a: string): void;',
    '  over(a: number): void;',
    '  over(a: unknown): void {}',
    '  handle = () => 1;',
    '  plain = 5;',
    '}',
    '',
  ].join('\n');
  const entities = byId(inline(source));
  for (const name of ['C.get x', 'C.set x', 'C.constructor', 'C.make', 'C.%23priv', 'C.computed', 'C.over', 'C.handle']) {
    assert.ok(entities.has(`src/m.ts#${name}`), name);
  }
  assert.ok(![...entities.keys()].some(id => id.includes('iterator') || id.includes('nope') || id.includes('plain')));
  const over = entities.get('src/m.ts#C.over')!;
  assert.deepEqual([over.startLine, over.endLine], [11, 13]);
  assert.equal([...entities.keys()].filter(id => id.includes('#C.over')).length, 1);
});

test('inline: class in a function, class expression, nested object literals', () => {
  const source = [
    'export function f() {',
    '  class Cart { add() { function helper() {} helper(); } }',
    '  return new Cart();',
    '}',
    'export const K = class { run() {} };',
    'declare const short: number; declare const rest: object;',
    'export const api = { users: { list() { return 1; } }, get: () => 2, short, ...rest } as const;',
    'export default { go() {} };',
    '',
  ].join('\n');
  const entities = byId(inline(source));
  for (const name of ['f>Cart.add', 'f>Cart.add>helper', 'K.run', 'api.users.list', 'api.get', 'default.go']) {
    assert.ok(entities.has(`src/m.ts#${name}`), name);
  }
  assert.equal(entities.get('src/m.ts#f>Cart.add')!.container, 'f>Cart');
  assert.ok(!entities.has('src/m.ts#K') && !entities.has('src/m.ts#api'));
  assert.ok(![...entities.keys()].some(id => id.includes('short') || id.includes('rest')));
});

const CART = [
  'export class Cart {',
  '  add(n: number) {',
  '    const a = n + 1;',
  '    const b = a + 1;',
  '    return b;',
  '  }',
  '}',
  'export class List {',
  '  add(n: number) {',
  '    const a = n + 1;',
  '    const b = a + 1;',
  '    return b;',
  '  }',
  '}',
  '',
].join('\n');

test('Cart vs List: an edit in Cart.add is attributed to Cart.add only; legacy sees nothing', () => {
  const head = CART.replace('    const b = a + 1;\n', '    const b = a + 2;\n');
  const run = (engine: 'legacy' | 'extended') =>
    analyzeSources({ base: { 'src/m.ts': CART }, head: { 'src/m.ts': head }, engine });
  const extended = run('extended');
  assert.deepEqual(extended.changedEntities.map(changed => changed.entity.id), ['src/m.ts#Cart.add']);
  assertValid(extended);

  const removed = analyzeSources({
    base: { 'src/m.ts': CART },
    head: { 'src/m.ts': CART.replace('    const b = a + 1;\n    return b;\n  }\n}\nexport class List', '    return a;\n  }\n}\nexport class List') },
    engine: 'extended',
  });
  const ids = removed.changedEntities.map(changed => changed.entity.id);
  assert.ok(ids.includes('src/m.ts#Cart.add'));
  assert.ok(!ids.includes('src/m.ts#List.add'));
  assert.ok(!ids.includes('src/m.ts#<module>'));

  assert.equal(run('legacy').outcome, 'no_supported_changes');
});
