import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepository, computeDeterministicEvidenceIdentity } from '../src/index';
import { createRepo } from './helpers/git-fixture';

const BASE = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
const HEAD = BASE.replace('return 1;', 'return 2;');

function buildRepo() {
  const repo = createRepo('graphentra-engine-');
  const base = repo.commitFile('src/app.ts', BASE, 'c1');
  const head = repo.commitFile('src/app.ts', HEAD, 'c2');
  return { repo, base, head };
}

test('engine profile: default engine is extended: default matches extended identity, legacy differs (schema 2.1)', () => {
  const { repo, base, head } = buildRepo();
  try {
    const run = (engine?: 'legacy' | 'extended') =>
      analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine });
    const legacy = run('legacy');
    const extended = run('extended');
    const unset = run();
    assert.notEqual(computeDeterministicEvidenceIdentity(legacy.evidence), computeDeterministicEvidenceIdentity(extended.evidence));
    assert.equal(computeDeterministicEvidenceIdentity(extended.evidence), computeDeterministicEvidenceIdentity(unset.evidence));
    assert.equal(unset.evidence.schemaVersion, '2.1');
    assert.equal(legacy.evidence.schemaVersion, '2.0');
  } finally {
    repo.cleanup();
  }
});

test('engine profile: unknown engine is rejected with INVALID_OPTIONS', () => {
  const { repo, base, head } = buildRepo();
  try {
    assert.throws(
      () => analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'bogus' as any }),
      (error: any) => error.code === 'INVALID_OPTIONS' && /Unknown engine "bogus"/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});
