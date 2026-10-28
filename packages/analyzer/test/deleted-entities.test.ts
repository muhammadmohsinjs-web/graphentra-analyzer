import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyzeResult } from '../src/contracts';
import { validateEvidenceEnvelope } from '../src/index';
import { analyzeFixture, analyzeSources, replaceOnce, type Files } from './helpers/fixture-repo';

const assertValid = (result: AnalyzeResult) => assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] });
const kinds = (result: AnalyzeResult) => result.changedEntities.map(changed => `${changed.entity.id}:${changed.changeKind}`);
const changedBy = (result: AnalyzeResult, id: string) => result.changedEntities.find(changed => changed.entity.id === id)!;
const relationKeys = (relations: Array<{ from: string; type: string; to: string }> | undefined) =>
  (relations ?? []).map(relation => `${relation.from}|${relation.type}|${relation.to}`);
const clone = <T>(value: T): any => JSON.parse(JSON.stringify(value));

const deleteChargeCard = (files: Files): Files => ({
  'src/billing.ts': replaceOnce(files['src/billing.ts'], `export function chargeCard(amount: number, cardToken: string): boolean {
  if (!cardToken || amount <= 1) {
    return false;
  }
  return true;
}

`, ''),
});

test('deleting chargeCard reports a deleted entity whose impact lists its base callers', () => {
  const result = analyzeFixture({ fixture: 'test-project', engine: 'extended', edits: deleteChargeCard });
  assert.equal(result.outcome, 'completed');
  const deleted = changedBy(result, 'src/billing.ts#chargeCard');
  assert.equal(deleted.changeKind, 'deleted');
  assert.deepEqual(deleted.baseEntity, { id: 'src/billing.ts#chargeCard', file: 'src/billing.ts', startLine: 3, endLine: 8 });
  assert.equal(deleted.change.addedCode.length, 0);
  assert.ok(deleted.change.removedCode.some(line => line.includes('amount <= 1')));
  assert.ok(deleted.change.changedLines.every(line => line >= 3 && line <= 8));
  assert.equal(result.technicalGraph.entities.some(entity => entity.id === deleted.entity.id), false);

  const impact = result.impacts.find(item => item.changedEntity.id === deleted.entity.id)!;
  const affected = impact.blastRadius.entities.map(entity => entity.id);
  for (const id of ['src/billing.ts#processPayment', 'src/orders.ts#submitOrder', 'src/orders.ts#handleCheckout']) assert.ok(affected.includes(id), id);
  // Surviving callers are reported as their head versions (processPayment moved up).
  const head = new Map(result.technicalGraph.entities.map(entity => [entity.id, entity]));
  assert.deepEqual(impact.directDependents, [head.get('src/billing.ts#processPayment')]);
  assert.deepEqual(result.evidence.baseEntities, [deleted.baseEntity]);
  assertValid(result);

  const legacy = analyzeFixture({ fixture: 'test-project', engine: 'legacy', edits: deleteChargeCard });
  assert.equal(legacy.evidence.baseEntities, undefined);
  assert.ok(legacy.changedEntities.every(changed => changed.changeKind === undefined));
});

test('a pure rename with updated call sites is renamed, not deleted plus added', () => {
  const result = analyzeFixture({ fixture: 'test-project', engine: 'extended', edits: files => ({
    'src/billing.ts': files['src/billing.ts'].replaceAll('chargeCard', 'captureCard') }) });
  assert.deepEqual(kinds(result), ['src/billing.ts#captureCard:renamed', 'src/billing.ts#processPayment:modified']);
  const renamed = changedBy(result, 'src/billing.ts#captureCard');
  assert.equal(renamed.baseEntity!.id, 'src/billing.ts#chargeCard');
  assert.deepEqual(result.evidence.baseEntities, [renamed.baseEntity]);
  // The call site changed its target name only, which is not an edge change once the rename is mapped.
  assert.equal(changedBy(result, 'src/billing.ts#processPayment').edgeDeltas, undefined);
  assert.equal(renamed.edgeDeltas, undefined);
  assert.ok(result.diagnostics.every(item => item.code !== 'AMBIGUOUS_CORRESPONDENCE'));
  assertValid(result);
});

test('dropping a call records the removed CALLS edge', () => {
  // submitOrder reaches applyDiscount through calculateOrderTotal, which owns the direct edge.
  const result = analyzeFixture({ fixture: 'test-project', engine: 'extended', edits: files => ({
    'src/pricing.ts': replaceOnce(files['src/pricing.ts'], 'applyDiscount(subtotal, discountPercentage);', 'subtotal;') }) });
  const changed = changedBy(result, 'src/pricing.ts#calculateOrderTotal');
  assert.equal(changed.changeKind, 'modified');
  assert.deepEqual(relationKeys(changed.edgeDeltas?.removed), ['src/pricing.ts#calculateOrderTotal|CALLS|src/pricing.ts#applyDiscount']);
  assert.deepEqual(changed.edgeDeltas?.added, []);
  assertValid(result);
});

test('a new call records the added edges and a new function is added', () => {
  const result = analyzeSources({
    base: { 'a.ts': 'export function one() { return 1; }\nexport function two() { return 2; }\nexport function main() { return one(); }\n' },
    head: { 'a.ts': 'export function one() { return 1; }\nexport function two() { return 2; }\nexport function main() { return one() + two() + three(); }\nexport function three() { return 3; }\n' },
    engine: 'extended',
  });
  assert.ok(kinds(result).includes('a.ts#three:added'));
  assert.equal(changedBy(result, 'a.ts#main').changeKind, 'modified');
  assert.deepEqual(relationKeys(changedBy(result, 'a.ts#main').edgeDeltas?.added), ['a.ts#main|CALLS|a.ts#three', 'a.ts#main|CALLS|a.ts#two']);
  assert.deepEqual(changedBy(result, 'a.ts#main').edgeDeltas?.removed, []);
  assert.equal(changedBy(result, 'a.ts#three').edgeDeltas, undefined);
  assertValid(result);
});

test('a deleted entity lists all its outgoing base edges as removed', () => {
  const result = analyzeSources({
    base: { 'a.ts': 'export function leaf() { return 1; }\nexport function other() { return 2; }\nexport function gone() { return leaf() + other(); }\nexport function keep() { return gone(); }\n' },
    head: { 'a.ts': 'export function leaf() { return 1; }\nexport function other() { return 2; }\nexport function keep() { return 0; }\n' },
    engine: 'extended',
  });
  const gone = changedBy(result, 'a.ts#gone');
  assert.equal(gone.changeKind, 'deleted');
  assert.deepEqual(gone.edgeDeltas, { added: [], removed: [
    { from: 'a.ts#gone', to: 'a.ts#leaf', type: 'CALLS' }, { from: 'a.ts#gone', to: 'a.ts#other', type: 'CALLS' }] });
  assert.deepEqual(result.impacts.find(item => item.changedEntity.id === 'a.ts#gone')!.blastRadius.entities.map(entity => entity.id), ['a.ts#keep']);
  assertValid(result);
});

test('deleting a whole chain keeps base-only path entities and validates without relation continuity', () => {
  const result = analyzeSources({
    base: { 'a.ts': 'export function a1() { return 1; }\nexport function b1() { return a1(); }\nexport function c1() { return b1(); }\n' },
    head: { 'a.ts': 'export function c1() { return 3; }\n' },
    engine: 'extended',
  });
  assert.deepEqual(kinds(result).filter(item => item.endsWith(':deleted')), ['a.ts#a1:deleted', 'a.ts#b1:deleted']);
  const impact = result.impacts.find(item => item.changedEntity.id === 'a.ts#a1')!;
  const longest = impact.blastRadius.paths.find(path => path.target.id === 'a.ts#c1')!;
  assert.deepEqual(longest.path.map(entity => entity.id), ['a.ts#a1', 'a.ts#b1', 'a.ts#c1']);
  assert.deepEqual(result.evidence.baseEntities!.map(entity => entity.id), ['a.ts#a1', 'a.ts#b1']);
  assertValid(result);

  const unlisted = clone(result.evidence);
  unlisted.baseEntities = unlisted.baseEntities.filter((entity: { id: string }) => entity.id !== 'a.ts#b1');
  assert.ok(validateEvidenceEnvelope(unlisted).errors.some(error => error.includes('must exist in technicalGraph.entities or baseEntities')));

  const moved = clone(result.evidence);
  moved.baseEntities[1].startLine += 5;
  assert.ok(validateEvidenceEnvelope(moved).errors.some(error => error.includes('differs from baseEntities coordinates')));

  const missing = clone(result.evidence);
  const target = missing.impacts.find((item: any) => item.changedEntity.id === 'a.ts#a1').blastRadius.paths.find((path: any) => path.depth === 2);
  target.path[1] = { ...target.path[1], id: 'a.ts#nowhere' };
  assert.ok(validateEvidenceEnvelope(missing).errors.some(error => error.includes('a.ts#nowhere')));
});

test('ambiguous correspondence is deleted plus added and emits a warning', () => {
  const result = analyzeSources({
    base: { 'a.ts': 'export function f1() { return 7; }\nexport function f2() { return 7; }\n' },
    head: { 'a.ts': 'export function g1() { return 7; }\nexport function g2() { return 7; }\n' },
    engine: 'extended',
  });
  const found = kinds(result).filter(item => !item.includes('<module>')).sort();
  assert.deepEqual(found, ['a.ts#f1:deleted', 'a.ts#f2:deleted', 'a.ts#g1:added', 'a.ts#g2:added']);
  const warnings = result.diagnostics.filter(item => item.code === 'AMBIGUOUS_CORRESPONDENCE');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'warning');
  assert.match(warnings[0].message, /\[a\.ts#f1, a\.ts#f2\].*\[a\.ts#g1, a\.ts#g2\]/);
  assertValid(result);
});

test('a deleted file reports its entities as deleted with a completed outcome', () => {
  const result = analyzeSources({
    base: { 'a.ts': 'export function keep() { return 1; }\n', 'gone.ts': "import { keep } from './a';\nexport function user() { return keep(); }\n" },
    head: {},
    removed: ['gone.ts'],
    engine: 'extended',
  });
  assert.equal(result.outcome, 'completed');
  assert.ok(kinds(result).includes('gone.ts#user:deleted'));
  assertValid(result);
});
