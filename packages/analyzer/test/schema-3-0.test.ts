import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EvidenceValidationError,
  computeDeterministicEvidenceIdentity,
  readEvidence,
  validateEvidenceEnvelope,
  type DeterministicEvidence,
} from '../src/index';

const load = (dir: string, name: string): DeterministicEvidence => JSON.parse(readFileSync(join(__dirname, 'fixtures', dir, name), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const EXAMPLES = ['web-app.json', 'tests-mapping.json', 'non-web-config.json'];
const web = () => load('evidence-3.0', 'web-app.json');
const withTests = () => load('evidence-3.0', 'tests-mapping.json');
const nonWeb = () => load('evidence-3.0', 'non-web-config.json');

function rejects(doc: unknown, pattern: RegExp): void {
  const result = validateEvidenceEnvelope(doc);
  assert.equal(result.valid, false, 'expected the document to be rejected');
  assert.ok(result.errors.some(error => pattern.test(error)), `no error matched ${pattern}: ${result.errors.join(' | ')}`);
}

test('schema 3.0 examples validate', () => {
  for (const name of EXAMPLES) {
    const doc = load('evidence-3.0', name);
    assert.equal(doc.schemaVersion, '3.0');
    assert.deepEqual(validateEvidenceEnvelope(doc), { valid: true, errors: [] }, name);
  }
});

test('example web-app reaches a ui route through an endpoint', () => {
  const surfaces = web().impacts[0].affectedSurfaces!;
  assert.deepEqual(surfaces.map(item => item.surfaceId), ['api:GET /api/users', 'ui:/']);
  assert.ok(surfaces[1].path.includes('api:GET /api/users'));
});

test('surface rules reject broken copies', () => {
  const unsorted = web(); unsorted.surfaces!.reverse(); rejects(unsorted, /surfaces must be sorted/);
  const dup = web(); dup.surfaces!.push(clone(dup.surfaces![1])); rejects(dup, /surfaces must be sorted/);
  const kind = web(); (kind.surfaces![0] as any).kind = 'bogus'; rejects(kind, /kind/);
  const handler = web(); handler.surfaces![0].handlerEntityIds = ['missing.ts#nope']; rejects(handler, /handlerEntityIds entity "missing.ts#nope"/);
  const handlerOrder = nonWeb(); handlerOrder.surfaces![0].handlerEntityIds = ['src/z.ts#a', 'src/a.ts#b']; rejects(handlerOrder, /handlerEntityIds must be sorted/);
  const missingField = web(); delete (missingField.surfaces![0] as any).adapter; rejects(missingField, /adapter/);
});

test('surface edge rules reject broken copies', () => {
  const unsorted = web(); unsorted.surfaceEdges!.reverse(); rejects(unsorted, /surfaceEdges must be sorted/);
  const type = web(); (type.surfaceEdges![0] as any).type = 'CALLS'; rejects(type, /type/);
  const handledByEntity = web();
  handledByEntity.surfaceEdges!.find(edge => edge.type === 'SURFACE_HANDLED_BY')!.to = 'nope.ts#x';
  rejects(handledByEntity, /not found in technicalGraph\.entities/);
  const handledBySurface = web();
  handledBySurface.surfaceEdges!.find(edge => edge.type === 'SURFACE_HANDLED_BY')!.from = 'api:GET /missing';
  rejects(handledBySurface, /surface "api:GET \/missing" not found/);
  const callsUi = web();
  callsUi.surfaceEdges!.find(edge => edge.type === 'CALLS_ENDPOINT')!.to = 'ui:/';
  rejects(callsUi, /must be of kind api_endpoint/);
  const callsMissing = web();
  callsMissing.surfaceEdges!.find(edge => edge.type === 'CALLS_ENDPOINT')!.to = 'api:GET /missing';
  rejects(callsMissing, /surface "api:GET \/missing" not found/);
  const coversTest = withTests();
  coversTest.surfaceEdges!.find(edge => edge.type === 'TEST_COVERS')!.from = 'test:nope.ts#x';
  rejects(coversTest, /test "test:nope.ts#x" not found/);
  const coversTarget = withTests();
  coversTarget.surfaceEdges!.find(edge => edge.type === 'TEST_COVERS')!.to = 'nope';
  rejects(coversTarget, /not found in technicalGraph\.entities or surfaces/);
  const via = web(); via.surfaceEdges![0].via = 'goto'; rejects(via, /via is only allowed on TEST_COVERS/);
});

test('test and mapping rules reject broken copies', () => {
  const unsorted = withTests(); unsorted.tests!.reverse(); rejects(unsorted, /tests must be sorted/);
  const framework = withTests(); (framework.tests![0] as any).framework = 'mocha'; rejects(framework, /framework/);
  const testId = withTests(); testId.testMapping!.testsToRun[0].testId = 'test:nope.ts#x'; rejects(testId, /testId "test:nope.ts#x" not found/);
  const reaches = withTests(); reaches.testMapping!.testsToRun[0].reaches = ['ui:/missing']; rejects(reaches, /reaches surface "ui:\/missing" not found/);
  const reachesOrder = withTests(); reachesOrder.testMapping!.testsToRun[0].reaches = ['ui:/', 'api:GET /api/users']; rejects(reachesOrder, /reaches must be sorted/);
  const uncovered = withTests(); uncovered.testMapping!.uncoveredSurfaces = ['ui:/missing']; rejects(uncovered, /uncoveredSurfaces surface "ui:\/missing" not found/);
  const uncoveredOrder = withTests(); uncoveredOrder.testMapping!.uncoveredSurfaces = ['ui:/settings', 'ui:/']; rejects(uncoveredOrder, /uncoveredSurfaces must be sorted/);
  const runOrder = withTests(); runOrder.testMapping!.testsToRun.reverse(); rejects(runOrder, /testsToRun must be sorted/);
  const basis = withTests(); (basis.testMapping as any).basis = 'dynamic'; rejects(basis, /basis/);
});

test('affectedSurfaces and adapter rules reject broken copies', () => {
  const missing = web(); missing.impacts[0].affectedSurfaces![0].surfaceId = 'api:GET /missing'; rejects(missing, /surfaceId "api:GET \/missing" not found/);
  const tail = web(); tail.impacts[0].affectedSurfaces![0].path = ['a', 'b']; rejects(tail, /path must end with its surfaceId/);
  const order = web(); order.impacts[0].affectedSurfaces!.reverse(); rejects(order, /affectedSurfaces must be sorted/);
  const confidence = web(); (confidence.impacts[0].affectedSurfaces![0] as any).confidence = 'maybe'; rejects(confidence, /confidence/);
  const adapters = nonWeb(); adapters.adapters!.reverse(); rejects(adapters, /adapters must be sorted/);
  const config = nonWeb(); (config.config as any).sha256 = 'abc'; rejects(config, /sha256/);
});

test('schema 3.0 fields are rejected in 2.x documents', () => {
  for (const field of ['surfaces', 'surfaceEdges', 'tests', 'testMapping', 'config', 'adapters'] as const) {
    const doc = clone(nonWeb()) as any;
    doc.schemaVersion = '2.1';
    for (const other of ['surfaces', 'surfaceEdges', 'tests', 'testMapping', 'config', 'adapters']) delete doc[other];
    for (const impact of doc.impacts) delete impact.affectedSurfaces;
    assert.deepEqual(validateEvidenceEnvelope(doc), { valid: true, errors: [] });
    doc[field] = nonWeb()[field] ?? (field === 'tests' ? [] : field === 'testMapping' ? { basis: 'static-reach', testsToRun: [], uncoveredSurfaces: [] } : []);
    rejects(doc, new RegExp(`${field} is not allowed in schema 2\\.1`));
  }
  const doc = clone(nonWeb()) as any;
  doc.schemaVersion = '2.1';
  for (const other of ['surfaces', 'surfaceEdges', 'config', 'adapters']) delete doc[other];
  rejects(doc, /affectedSurfaces is not allowed in schema 2\.1/);
});

test('existing 2.x fixtures stay valid', () => {
  const valid = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'evidence', 'valid.json'), 'utf8'));
  assert.deepEqual(validateEvidenceEnvelope(valid), { valid: true, errors: [] });
});

test('readEvidence normalizes 2.0, 2.1 and 3.0', () => {
  const legacy = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'evidence', 'valid.json'), 'utf8'));
  const read20 = readEvidence(legacy);
  assert.equal(read20.schemaVersion, '2.0');
  assert.deepEqual([read20.surfaces, read20.surfaceEdges, read20.tests], [[], [], []]);
  assert.equal(read20.testMapping, undefined, 'the reader never invents a testMapping');
  assert.equal(read20.testMappingAvailable, false);
  assert.equal('surfaces' in legacy, false, 'input must not be modified');

  const extended = clone(nonWeb()) as any;
  extended.schemaVersion = '2.1';
  for (const field of ['surfaces', 'surfaceEdges', 'config', 'adapters']) delete extended[field];
  for (const impact of extended.impacts) delete impact.affectedSurfaces;
  const read21 = readEvidence(extended);
  assert.equal(read21.schemaVersion, '2.1');
  assert.deepEqual(read21.surfaces, []);

  const read30 = readEvidence(withTests());
  assert.equal(read30.surfaces.length, 3);
  assert.equal(read30.tests.length, 2);
  assert.deepEqual(read30.testMapping?.uncoveredSurfaces, ['ui:/settings']);
  assert.equal(read30.testMappingAvailable, true);
  const noMapping = withTests() as any; delete noMapping.testMapping;
  const read30NoMapping = readEvidence(noMapping);
  assert.equal(read30NoMapping.testMapping, undefined);
  assert.equal(read30NoMapping.testMappingAvailable, false);

  assert.throws(() => readEvidence({ schemaVersion: '9.9' }), EvidenceValidationError);
  const broken = web(); broken.surfaces!.reverse();
  assert.throws(() => readEvidence(broken), /surfaces must be sorted/);
});

test('identity ignores 3.0 array order and is unchanged for 2.x', () => {
  const a = withTests();
  const b = clone(a);
  b.surfaces!.reverse(); b.surfaceEdges!.reverse(); b.tests!.reverse(); b.adapters!.reverse();
  b.testMapping!.testsToRun.reverse(); b.impacts[0].affectedSurfaces!.reverse();
  assert.equal(computeDeterministicEvidenceIdentity(a), computeDeterministicEvidenceIdentity(b));
  const c = clone(a); c.surfaces![0].confidence = 'likely';
  assert.notEqual(computeDeterministicEvidenceIdentity(a), computeDeterministicEvidenceIdentity(c));
  // 2.x payload carries none of the new keys, so existing identities (pinned by golden.test.ts) are unchanged.
  const legacy = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'evidence', 'valid.json'), 'utf8'));
  assert.match(computeDeterministicEvidenceIdentity(legacy), /^[a-f0-9]{64}$/);
});
