import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplicationContext, Entity, EntityImpact } from '../src/index';
import { extractEntityChange, parseGitDiff } from '../src/change-evidence';
import { buildLLMPayload, getSourceRole, qaInstruction } from '../src/qa-evidence';

const catalog: Entity = { id: 'src/service.ts#getCatalog', name: 'getCatalog', kind: 'function', file: 'src/service.ts', startLine: 1, endLine: 3 };
const checkout: Entity = { ...catalog, id: 'src/service.ts#checkout', name: 'checkout', startLine: 4, endLine: 6 };
const server: Entity = { ...catalog, id: 'src/server.ts#createServer', name: 'createServer', file: 'src/server.ts' };
const tests: Entity = { ...catalog, id: 'tests/test.ts#runTests', name: 'runTests', file: 'tests/test.ts' };
const context: ApplicationContext = {
  schemaVersion: '1.0',
  application: { name: 'Demo', summary: 'Catalog and checkout', purpose: 'Catalog and checkout' },
  domains: [{ id: 'catalog', name: 'Catalog', description: 'Catalog plus unrelated checkout description' }, { id: 'checkout', name: 'Checkout', description: 'Checkout' }],
  terminology: [{ term: 'stock', meaning: 'Available units' }, { term: 'cart', meaning: 'Cart entries' }],
  entityAnnotations: [
    { entityId: catalog.id, businessMeaning: 'Classify stock', domainIds: ['catalog'], confidence: 'high' },
    { entityId: checkout.id, businessMeaning: 'Check cart entry count', domainIds: ['checkout'], confidence: 'high' },
  ],
  applicationFacts: ['Unscoped catalog and checkout facts'],
  unknowns: ['Unscoped catalog and checkout unknowns'],
};

function impactFor(entity: Entity): EntityImpact {
  const [file] = parseGitDiff(`diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,6 +1,6 @@
 function getCatalog() {
-  return stock <= 5;
+  return stock <= 10;
 }
 function checkout() {
-  return cart.items.length === 0;
+  return cart.items.length === 50;
 }`);
  return {
    changedEntity: entity,
    change: extractEntityChange(file, entity, entity)!,
    directDependents: [server, tests],
    blastRadius: {
      totalAffectedEntities: 2,
      entities: [server, tests],
      paths: [
        { target: server, depth: 1, path: [entity, server] },
        { target: tests, depth: 1, path: [entity, tests] },
        { target: tests, depth: 2, path: [entity, server, tests] },
      ],
    },
    terminalDependents: [tests],
  };
}

test('multiple changed functions produce one payload with isolated change evidence', () => {
  const payload = buildLLMPayload([impactFor(catalog), impactFor(checkout)], context);
  assert.equal(payload.analysisScope.changedFunctionCount, 2);
  assert.deepEqual(payload.changes.map(item => item.change.changedLines), [[2], [5]]);
  assert.match(JSON.stringify(payload.changes[0]), /getCatalog|stock|<= 10/i);
  assert.doesNotMatch(JSON.stringify(payload.changes[0]), /checkout|cart|=== 50/i);
  assert.match(JSON.stringify(payload.changes[1]), /checkout|cart|=== 50/i);
  assert.doesNotMatch(JSON.stringify(payload.changes[1]), /getCatalog|stock|<= 10/i);
  assert.deepEqual(payload.applicationContext.entityAnnotations.map(item => item.entityId), [catalog.id, checkout.id]);
  assert.ok(!('technicalGraph' in payload));
  assert.ok(!('hunks' in payload.changes[0].change));
});

test('test callers remain in every graph path but are classified separately in QA evidence', () => {
  const impact = impactFor(catalog);
  const original = JSON.stringify(impact);
  const payload = buildLLMPayload([impact], context);
  const [change] = payload.changes;
  assert.deepEqual(change.productionDependents.map(entity => entity.id), [server.id]);
  assert.deepEqual(change.testDependents.map(entity => entity.id), [tests.id]);
  assert.equal(change.directDependents[1].sourceRole, 'test');
  assert.equal(change.terminalDependents[0].sourceRole, 'test');
  assert.equal(change.blastRadius.paths[2].path[2].sourceRole, 'test');
  assert.equal(change.blastRadius.paths.length, 3);
  assert.equal(JSON.stringify(impact), original);
  assert.equal(buildLLMPayload([{ ...impact, changedEntity: tests }], context).changes[0].changedEntity.sourceRole, 'test');
});

test('obvious test paths are deterministic and ordinary files remain production', () => {
  for (const file of ['foo.test.ts', 'src/foo.spec.ts', 'test.ts', 'src/test.ts', 'tests/unit/run.ts', 'src/__tests__/run.ts', 'src\\__tests__\\run.ts', 'test/unit/run.ts', 'service.test.tsx', 'service.spec.mts', 'service.test.cts']) {
    assert.equal(getSourceRole(file), 'test', file);
  }
  for (const file of ['src/service.ts', 'src/contest.ts', 'src/testHelpers.ts', 'src/testsHelper/run.ts']) {
    assert.equal(getSourceRole(file), 'production', file);
  }
});

test('instructions preserve evidence authority, precise quantities, and plain field content', () => {
  assert.match(qaInstruction, /50 array entries, not necessarily 50 products/);
  assert.match(qaInstruction, /Test entities represent test coverage\/evidence/);
  assert.match(qaInstruction, /Never discover new dependencies/);
  assert.match(qaInstruction, /Never include Markdown/);
  assert.match(qaInstruction, /one short, unified report/);
  assert.match(qaInstruction, /Merge closely related changes/);
  assert.match(qaInstruction, /Do not\s+produce a section, summary, impact statement, or QA checklist for every changed function/);
  assert.match(qaInstruction, /removedCode as BEFORE with its addedCode as AFTER/);
  assert.match(qaInstruction, /Never ask QA to inspect code/);
});
