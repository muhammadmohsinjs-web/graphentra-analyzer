import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  analyzeRepository,
  computeDeterministicEvidenceIdentity,
  validateEvidenceEnvelope,
} from '../src/index';
import { createRepo } from './helpers/git-fixture';

/**
 * Determinism and portability (P0-5): same input => same identity hash, wherever and whenever it runs.
 * The clone-based portability case lives in evidence-contract.test.ts; these tests cover the rest.
 */
const BASE = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
const HEAD = BASE.replace('return 1;', 'return 2;');

function buildRepo() {
  const repo = createRepo('graphentra-det-');
  const base = repo.commitFile('src/app.ts', BASE, 'c1');
  const head = repo.commitFile('src/app.ts', HEAD, 'c2');
  return { repo, base, head };
}

const run = (dir: string, base: string, head: string) =>
  analyzeRepository({ target: dir, comparison: { mode: 'commit', base, head } });

test('determinism: repeated runs on the same repository give the same identity', () => {
  const { repo, base, head } = buildRepo();
  try {
    const a = run(repo.dir, base, head);
    const b = run(repo.dir, base, head);
    assert.equal(a.outcome, 'completed');
    assert.equal(computeDeterministicEvidenceIdentity(a.evidence), computeDeterministicEvidenceIdentity(b.evidence));
  } finally {
    repo.cleanup();
  }
});

test('determinism: a plain directory copy at a different absolute path gives the same identity', () => {
  const { repo, base, head } = buildRepo();
  const copyDir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-det-copy-'))), 'nested', 'checkout');
  try {
    fs.cpSync(repo.dir, copyDir, { recursive: true });
    const a = run(repo.dir, base, head);
    const b = run(copyDir, base, head);
    assert.notEqual(repo.dir, copyDir);
    assert.equal(computeDeterministicEvidenceIdentity(a.evidence), computeDeterministicEvidenceIdentity(b.evidence));
    assert.ok(!JSON.stringify(b.evidence).includes(copyDir), 'evidence must not contain absolute paths');
  } finally {
    repo.cleanup();
    fs.rmSync(path.dirname(path.dirname(copyDir)), { recursive: true, force: true });
  }
});

test('determinism: changing one source byte changes sourceState.contentIdentity', () => {
  const { repo, base, head } = buildRepo();
  try {
    const before = run(repo.dir, base, head);
    const head2 = repo.commitFile('src/app.ts', HEAD.replace('return 2;', 'return 3;'), 'c3');
    const after = run(repo.dir, base, head2);
    assert.match(before.evidence.sourceState.contentIdentity, /^[a-f0-9]{64}$/);
    assert.notEqual(before.evidence.sourceState.contentIdentity, after.evidence.sourceState.contentIdentity);
    assert.notEqual(
      computeDeterministicEvidenceIdentity(before.evidence),
      computeDeterministicEvidenceIdentity(after.evidence),
    );
  } finally {
    repo.cleanup();
  }
});

test('determinism: produced evidence passes validateEvidenceEnvelope', () => {
  const { repo, base, head } = buildRepo();
  try {
    const result = run(repo.dir, base, head);
    const validation = validateEvidenceEnvelope(result.evidence);
    assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join(', ')}`);
  } finally {
    repo.cleanup();
  }
});
