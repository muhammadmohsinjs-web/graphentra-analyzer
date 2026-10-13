import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXTENDED_LIMITATIONS,
  DEFAULT_LIMITATIONS,
  analyzeRepository,
  computeDeterministicEvidenceIdentity,
  validateEvidenceEnvelope,
  type DeterministicEvidence,
} from '../src/index';
import { createRepo } from './helpers/git-fixture';

const BASE = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
const HEAD = BASE.replace('return 1;', 'return 2;');

function run(engine: 'legacy' | 'extended'): DeterministicEvidence {
  const repo = createRepo('graphentra-s21-');
  try {
    const base = repo.commitFile('src/app.ts', BASE, 'c1');
    const head = repo.commitFile('src/app.ts', HEAD, 'c2');
    return analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine }).evidence;
  } finally {
    repo.cleanup();
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('extended engine emits schema 2.1 and validates', () => {
  const evidence = run('extended');
  assert.equal(evidence.schemaVersion, '2.1');
  assert.equal(evidence.options.engine, 'extended');
  assert.match(evidence.toolchain!.node, /^\d+\.x$/);
  assert.ok(evidence.technicalGraph.entities.length > 0);
  for (const entity of evidence.technicalGraph.entities) assert.equal(entity.language, 'typescript');
  for (const changed of evidence.changedEntities) assert.equal(changed.entity.language, 'typescript');
  assert.deepEqual(evidence.limitations, EXTENDED_LIMITATIONS);
  assert.deepEqual(validateEvidenceEnvelope(evidence), { valid: true, errors: [] });
});

test('legacy engine keeps the 2.0 shape', () => {
  const evidence = run('legacy');
  assert.equal(evidence.schemaVersion, '2.0');
  assert.ok(!('toolchain' in evidence));
  assert.ok(!('engine' in evidence.options));
  assert.deepEqual(evidence.technicalGraph.capabilities.entityKinds, ['function']);
  assert.deepEqual(evidence.limitations, DEFAULT_LIMITATIONS);
  assert.ok(evidence.technicalGraph.entities.every(entity => !('language' in entity)));
  assert.equal(validateEvidenceEnvelope(evidence).valid, true);
});

test('validator applies per-version rules', () => {
  const extended = run('extended');
  const asLegacy = clone(extended);
  asLegacy.schemaVersion = '2.0';
  assert.equal(validateEvidenceEnvelope(asLegacy).valid, false);

  const withMethod = (container?: string): DeterministicEvidence => {
    const evidence = clone(extended);
    const file = evidence.technicalGraph.entities[0].file;
    evidence.technicalGraph.entities.push({ id: `${file}#C.m`, kind: 'method', name: 'C.m', file,
      startLine: 1, endLine: 1, language: 'typescript', ...(container ? { container } : {}) });
    evidence.technicalGraph.capabilities.entityKinds = ['function', 'method', 'module'];
    return evidence;
  };
  assert.deepEqual(validateEvidenceEnvelope(withMethod('C')).errors, []);
  assert.equal(validateEvidenceEnvelope(withMethod()).valid, false);

  const unlisted = withMethod('C');
  unlisted.technicalGraph.capabilities.entityKinds = ['function'];
  assert.equal(validateEvidenceEnvelope(unlisted).valid, false);
  const unsorted = withMethod('C');
  unsorted.technicalGraph.capabilities.entityKinds = ['method', 'function'];
  assert.equal(validateEvidenceEnvelope(unsorted).valid, false);
  const noLanguage = clone(extended);
  delete noLanguage.technicalGraph.entities[0].language;
  assert.equal(validateEvidenceEnvelope(noLanguage).valid, false);
});

test('2.0 evidence rejects toolchain', () => {
  const evidence = clone(run('legacy'));
  evidence.toolchain = { typescript: '5.8.2', node: '22.x' };
  assert.equal(validateEvidenceEnvelope(evidence).valid, false);
});

test('identity ignores toolchain.node but not toolchain.typescript', () => {
  const evidence = run('extended');
  const original = computeDeterministicEvidenceIdentity(evidence);
  const otherNode = clone(evidence);
  otherNode.toolchain!.node = '99.x';
  assert.equal(computeDeterministicEvidenceIdentity(otherNode), original);
  const otherTs = clone(evidence);
  otherTs.toolchain!.typescript = '0.0.1';
  assert.notEqual(computeDeterministicEvidenceIdentity(otherTs), original);
  assert.notEqual(evidence.toolchain!.node, '99.x');
});
