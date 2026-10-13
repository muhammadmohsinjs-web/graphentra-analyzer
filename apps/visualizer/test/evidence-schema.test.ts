import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateEvidenceEnvelope } from '../src/evidence';

const sample = () => JSON.parse(readFileSync(path.join(__dirname, 'fixtures/evidence-2.1.json'), 'utf8'));

test('the evidence validator accepts a normalized 2.1 sample', () => {
  const result = validateEvidenceEnvelope(sample());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('the evidence validator rejects an unknown schema version', () => {
  assert.equal(validateEvidenceEnvelope({ ...sample(), schemaVersion: '9.9' }).valid, false);
});
