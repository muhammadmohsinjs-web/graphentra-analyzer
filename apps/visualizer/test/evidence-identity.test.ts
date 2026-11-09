import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { computeEvidenceIdentity } from '../src/evidence';

// The visualizer may not import the analyzer, so both sides are checked against one shared table of identities
// computed by the analyzer (packages/analyzer/test/evidence-identity.test.ts asserts the same table).
const ROOT = path.join(__dirname, '../../..');
const IDENTITIES: Record<string, string> = JSON.parse(readFileSync(path.join(ROOT, 'packages/analyzer/test/fixtures/evidence-identities.json'), 'utf8'));

test('visualizer evidence identity equals the analyzer identity for 2.1 and 3.0 documents', () => {
  assert.ok(Object.keys(IDENTITIES).some(file => file.includes('evidence-3.0/')));
  for (const [file, identity] of Object.entries(IDENTITIES)) {
    assert.equal(computeEvidenceIdentity(JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'))), identity, file);
  }
});

test('visualizer identity ignores 3.0 array order and toolchain.node', () => {
  const file = 'packages/analyzer/test/fixtures/evidence-3.0/tests-mapping.json';
  const doc = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  for (const key of ['surfaces', 'surfaceEdges', 'tests', 'adapters']) doc[key]?.reverse();
  doc.testMapping?.testsToRun.reverse();
  for (const impact of doc.impacts) impact.affectedSurfaces?.reverse();
  if (doc.toolchain) doc.toolchain.node = 'v0.0.0-other';
  assert.equal(computeEvidenceIdentity(doc), IDENTITIES[file]);
});
