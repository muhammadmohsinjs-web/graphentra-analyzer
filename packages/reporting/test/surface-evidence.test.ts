import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readEvidence } from '@graphentra/analyzer';
import { buildSurfaceEvidence, formatSurfaceEvidence } from '../src/index';

const load = (file: string) => JSON.parse(readFileSync(path.join(__dirname, file), 'utf8'));
const v21 = () => load('../../../apps/visualizer/test/fixtures/evidence-2.1.json');
const v30 = () => load('../../analyzer/test/fixtures/evidence-3.0/tests-mapping.json');

test('2.1 evidence produces no surface sections', () => {
  const evidence = readEvidence(v21());
  assert.equal(evidence.schemaVersion, '2.1');
  assert.equal(buildSurfaceEvidence(evidence), undefined);
  assert.equal(formatSurfaceEvidence(buildSurfaceEvidence(evidence)), '');
});

test('3.0 evidence adds affected surfaces, tests to run and uncovered surfaces', () => {
  const evidence = readEvidence(v30());
  const surfaceEvidence = buildSurfaceEvidence(evidence)!;
  assert.ok(surfaceEvidence.affectedSurfaces.some(item => item.surfaceId === 'api:GET /api/users' && item.depth === 2 && item.confidence === 'proven'));
  assert.deepEqual(surfaceEvidence.uncoveredSurfaces, ['ui:/settings']);
  const markdown = formatSurfaceEvidence(surfaceEvidence);
  assert.match(markdown, /## Affected surfaces\n\n- `api:GET \/api\/users` \(depth 2, proven\)/);
  assert.match(markdown, /## Tests to run\n\n- `test:e2e\/home\.cy\.ts#home > loads users` reaches `ui:\/`/);
  assert.match(markdown, /## Uncovered surfaces\n\n- `ui:\/settings`/);
});
