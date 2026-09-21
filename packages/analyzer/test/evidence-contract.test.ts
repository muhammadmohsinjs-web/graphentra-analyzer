import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ANALYZER_VERSION,
  EVIDENCE_ARTIFACT_KIND,
  EVIDENCE_SCHEMA_VERSION,
  type DeterministicEvidence,
  analyzeRepository,
  assertValidEvidenceEnvelope,
  computeDeterministicEvidenceIdentity,
  validateEvidenceEnvelope,
} from '../src/index';

import { createRepo } from './helpers/git-fixture';

test('evidence contract: all four successful outcomes produce valid envelopes', () => {
  // 1. no_source_files outcome
  const repo1 = createRepo('graphentra-no-src-');
  try {
    repo1.commitFile('README.md', '# Just readme', 'Initial');
    const result = analyzeRepository({
      target: repo1.dir,
      comparison: { mode: 'working-tree' },
    });
    assert.equal(result.outcome, 'no_source_files');
    assert.ok(result.evidence);
    const valResult = validateEvidenceEnvelope(result.evidence);
    assert.equal(valResult.valid, true, `Validation failed: ${valResult.errors.join(', ')}`);
  } finally {
    repo1.cleanup();
  }

  // 2. no_changes outcome
  const repo2 = createRepo('graphentra-no-chg-');
  try {
    repo2.commitFile('src/calc.ts', 'export function add(a: number, b: number): number { return a + b; }', 'Initial');
    const result = analyzeRepository({
      target: repo2.dir,
      comparison: { mode: 'working-tree' },
    });
    assert.equal(result.outcome, 'no_changes');
    assert.ok(result.evidence);
    const valResult = validateEvidenceEnvelope(result.evidence);
    assert.equal(valResult.valid, true, `Validation failed: ${valResult.errors.join(', ')}`);
  } finally {
    repo2.cleanup();
  }

  // 3. no_supported_changes outcome (change in non-function code)
  const repo3 = createRepo('graphentra-no-supp-');
  try {
    repo3.commitFile('src/calc.ts', 'export const PI = 3.14;\nexport function add(a: number, b: number): number { return a + b; }', 'Initial');
    // Modify only the constant outside any function
    fs.writeFileSync(
      path.join(repo3.dir, 'src/calc.ts'),
      'export const PI = 3.14159;\nexport function add(a: number, b: number): number { return a + b; }',
      'utf8',
    );
    const result = analyzeRepository({
      target: repo3.dir,
      comparison: { mode: 'working-tree' },
    });
    assert.equal(result.outcome, 'no_supported_changes');
    assert.ok(result.evidence);
    const valResult = validateEvidenceEnvelope(result.evidence);
    assert.equal(valResult.valid, true, `Validation failed: ${valResult.errors.join(', ')}`);
  } finally {
    repo3.cleanup();
  }

  // 4. completed outcome
  const repo4 = createRepo('graphentra-completed-');
  try {
    const baseSha = repo4.commitFile('src/calc.ts', 'export function add(a: number, b: number): number { return a + b; }', 'Initial');
    const headSha = repo4.commitFile('src/calc.ts', 'export function add(a: number, b: number): number { return a + b + 0; }', 'Update');
    const result = analyzeRepository({
      target: repo4.dir,
      comparison: { mode: 'commit', base: baseSha, head: headSha },
    });
    assert.equal(result.outcome, 'completed');
    assert.ok(result.evidence);
    const valResult = validateEvidenceEnvelope(result.evidence);
    assert.equal(valResult.valid, true, `Validation failed: ${valResult.errors.join(', ')}`);
  } finally {
    repo4.cleanup();
  }
});

test('evidence contract: schema validation detects violations and invariants', () => {
  const baseValid: DeterministicEvidence = {
    artifactKind: EVIDENCE_ARTIFACT_KIND,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    target: { targetPath: '.' },
    options: { excludePaths: [], sourcePolicy: 'git-tracked' },
    comparison: {
      mode: 'commit',
      resolvedBaseSha: '1111111111111111111111111111111111111111',
      resolvedHeadSha: '2222222222222222222222222222222222222222',
      comparedTo: '`HEAD`',
    },
    sourceState: {
      contentIdentity: '0'.repeat(64),
      checkoutSha: '2222222222222222222222222222222222222222',
      isTrackedDirty: false,
      untrackedSourcePolicy: 'excluded',
    },
    outcome: 'no_changes',
    technicalGraph: {
      schemaVersion: '1.0',
      repository: {
        targetPath: '.',
        headSha: '2222222222222222222222222222222222222222',
        analyzerVersion: ANALYZER_VERSION,
      },
      capabilities: {
        language: 'typescript',
        entityKinds: ['function'],
        relationTypes: ['CALLS'],
        maxBlastDepth: 6,
      },
      analyzedFiles: ['src/index.ts'],
      entities: [
        {
          id: 'src/index.ts#foo',
          kind: 'function',
          name: 'foo',
          file: 'src/index.ts',
          startLine: 1,
          endLine: 3,
        },
      ],
      relations: [],
    },
    changedFiles: [],
    changedEntities: [],
    impacts: [],
    diagnostics: [],
    limitations: [],
  };

  assert.equal(validateEvidenceEnvelope(baseValid).valid, true);

  // 1. Wrong artifact kind
  const badKind = { ...baseValid, artifactKind: 'wrong-kind' };
  assert.equal(validateEvidenceEnvelope(badKind).valid, false);

  // 2. Wrong schema version
  const badVersion = { ...baseValid, schemaVersion: '1.0' };
  assert.equal(validateEvidenceEnvelope(badVersion).valid, false);

  // 3. Absolute path in targetPath
  const badTargetPath = { ...baseValid, target: { targetPath: '/var/root' } };
  assert.equal(validateEvidenceEnvelope(badTargetPath).valid, false);

  // 4. Duplicate entity IDs in graph
  const duplicateEntities = {
    ...baseValid,
    technicalGraph: {
      ...baseValid.technicalGraph,
      entities: [
        baseValid.technicalGraph.entities[0],
        baseValid.technicalGraph.entities[0],
      ],
    },
  };
  assert.equal(validateEvidenceEnvelope(duplicateEntities).valid, false);

  // 5. Dangling relation endpoint
  const danglingRelation = {
    ...baseValid,
    technicalGraph: {
      ...baseValid.technicalGraph,
      relations: [
        {
          from: 'src/index.ts#foo',
          to: 'src/index.ts#nonExistent',
          type: 'CALLS' as const,
        },
      ],
    },
  };
  assert.equal(validateEvidenceEnvelope(danglingRelation).valid, false);

  // 6. Inverted line range
  const invertedLines = {
    ...baseValid,
    technicalGraph: {
      ...baseValid.technicalGraph,
      entities: [
        {
          ...baseValid.technicalGraph.entities[0],
          startLine: 10,
          endLine: 5,
        },
      ],
    },
  };
  assert.equal(validateEvidenceEnvelope(invertedLines).valid, false);

  // 7. Outcome inconsistency (completed with no changed entities)
  const inconsistentCompleted = {
    ...baseValid,
    outcome: 'completed' as const,
    changedEntities: [],
  };
  assert.equal(validateEvidenceEnvelope(inconsistentCompleted).valid, false);
});

test('evidence contract: portability and deterministic equivalence across checkout locations', () => {
  const repoA = createRepo('graphentra-port-a-');
  const rawDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-port-b-'));
  const repoBDir = fs.realpathSync(rawDirB);

  try {
    const code1 = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
    const code2 = 'export function helper(): number { return 2; }\nexport function main(): number { return helper(); }\n';

    const baseA = repoA.commitFile('src/app.ts', code1, 'c1');
    const headA = repoA.commitFile('src/app.ts', code2, 'c2');

    // Clone repoA to repoBDir so commits and history are identical
    execFileSync('git', ['clone', repoA.dir, repoBDir], { encoding: 'utf8' });

    const resultA = analyzeRepository({
      target: repoA.dir,
      comparison: { mode: 'commit', base: baseA, head: headA },
    });

    const resultB = analyzeRepository({
      target: repoBDir,
      comparison: { mode: 'commit', base: baseA, head: headA },
    });

    // Check that target paths in evidence are relative ('.'), not absolute host paths
    assert.equal(resultA.evidence.target.targetPath, '.');
    assert.equal(resultB.evidence.target.targetPath, '.');

    // Both should produce identical deterministic identity
    const hashA = computeDeterministicEvidenceIdentity(resultA.evidence);
    const hashB = computeDeterministicEvidenceIdentity(resultB.evidence);
    assert.equal(hashA, hashB, 'Evidence across identical repositories in different paths must produce identical identity');
  } finally {
    repoA.cleanup();
    fs.rmSync(repoBDir, { recursive: true, force: true });
  }
});
