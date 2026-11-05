import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextPack } from '../src/context-pack';
import type { ApplicationContextV2 } from '../src/context-contract';

// These tests assert today's misses from impactbench/gaps/gaps.json. A failure here can be good news:
// if a fix made it fail, change the test to assert the new behavior and mark the gap as fixed.

test('GAP-002 a feature that lists the changed file is not linked to the change', () => {
  // Reduced from excalidraw-11: a file-level context has no annotations, and that repo has no surfaces.
  const feature = {
    id: 'charts-and-paste', name: 'Create drawing content from pasted data', description: '', criticality: 'normal',
    criticalityReason: '', files: ['src/charts.ts', 'src/clipboard.ts'], surfaceIds: [], basis: 'documentation',
  };
  const context = {
    schemaVersion: '2.0',
    meta: { coverage: {} },
    application: { name: 'app', summary: '', purpose: '', platform: '', userRoles: [] },
    features: [feature],
    surfaces: [],
    fileSummaries: [{ file: 'src/clipboard.ts', fingerprint: 'f', summary: 'Clipboard helpers.' }],
    glossary: [],
    entityAnnotations: [],
    rules: [],
    openQuestions: [],
    unknowns: [],
  } as unknown as ApplicationContextV2;
  const entity = { id: 'src/clipboard.ts#getSystemClipboard', kind: 'function', name: 'getSystemClipboard', file: 'src/clipboard.ts', startLine: 1, endLine: 2 };
  const impact = {
    changedEntity: entity, change: { file: entity.file, diff: '' }, directDependents: [],
    blastRadius: { totalAffectedEntities: 0, entities: [], paths: [], truncated: false }, terminalDependents: [],
  } as unknown as Parameters<typeof buildContextPack>[1][number];

  const pack = buildContextPack(context, [impact]);
  assert.equal(pack.changes[0]!.fileRole, 'Clipboard helpers.');
  // The miss: the feature names this file, but the change gets no feature.
  assert.deepEqual(pack.changes[0]!.features, []);
});
