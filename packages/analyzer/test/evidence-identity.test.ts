import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { computeDeterministicEvidenceIdentity } from '../src/index';

// Shared with apps/visualizer/test/evidence-identity.test.ts: both implementations must give these identities.
const ROOT = path.join(__dirname, '../../..');
const IDENTITIES: Record<string, string> = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/evidence-identities.json'), 'utf8'));

test('analyzer evidence identities match the table shared with the visualizer', () => {
  for (const [file, identity] of Object.entries(IDENTITIES)) {
    assert.equal(computeDeterministicEvidenceIdentity(JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'))), identity, file);
  }
});
