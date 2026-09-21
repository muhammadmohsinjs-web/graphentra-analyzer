import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { validateEvidenceEnvelope } from '../src/validator';
import { computeDeterministicEvidenceIdentity } from '../src/deterministic';
const directory = path.join(__dirname, 'fixtures/evidence');
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'));
const schema = new Ajv2020({ strict: true }).compile(require('../evidence.schema.json'));
for (const name of ['valid', 'no-changes', 'no-supported-changes', 'no-source-files']) {
  test(`contract corpus accepts ${name} structurally and semantically`, () => {
    assert.equal(schema(load(name)), true);
    assert.deepEqual(validateEvidenceEnvelope(load(name)), { valid: true, errors: [] });
  });
}
for (const mutation of load('invalid-cases')) {
  test(`contract rejects ${mutation.name}`, () => {
    const evidence = load('valid');
    let parent = evidence;
    for (const key of mutation.path.slice(0, -1)) parent = parent[key];
    parent[mutation.path.at(-1)] = mutation.value;
    assert.equal(schema(evidence), mutation.category !== 'structural');
    assert.equal(validateEvidenceEnvelope(evidence).valid, false);
  });
}
test('identity preserves object-key equivalence and excludes only execution timestamp', () => {
  const evidence = load('valid');
  const identity = computeDeterministicEvidenceIdentity(evidence);
  const reverse = (value: any): any => Array.isArray(value) ? value.map(reverse)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  const reordered = reverse(evidence);
  reordered.technicalGraph.repository.generatedAt = '2026-01-01T00:00:00Z';
  assert.equal(computeDeterministicEvidenceIdentity(reordered), identity);
  reordered.diagnostics.push({ code: 'NEW_DIAGNOSTIC', severity: 'info', message: 'Semantic change.' });
  assert.notEqual(computeDeterministicEvidenceIdentity(reordered), identity);
});
