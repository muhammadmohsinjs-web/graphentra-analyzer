import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepository, computeDeterministicEvidenceIdentity } from '../src/index';
import { createRepo } from './helpers/git-fixture';

/**
 * Cross-OS determinism (P0-11). These tests run in the Linux, macOS and Windows CI jobs.
 * All three must give the same results, including the pinned golden hash below.
 */
const BASE = 'export function helper(): number { return 1; }\nexport function main(): number { return helper(); }\n';
const HEAD = BASE.replace('return 1;', 'return 2;');

function analyze(files: Record<string, [string, string]>) {
  const repo = createRepo('graphentra-xos-');
  try {
    let base = '';
    let head = '';
    for (const [file, [before]] of Object.entries(files)) base = repo.commitFile(file, before, `base ${file}`);
    for (const [file, [, after]] of Object.entries(files)) head = repo.commitFile(file, after, `head ${file}`);
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'legacy' });
    return { result, identity: computeDeterministicEvidenceIdentity(result.evidence) };
  } finally {
    repo.cleanup();
  }
}

const toCrlf = (text: string) => text.replace(/\n/g, '\r\n');

test('line endings: CRLF and LF give a different contentIdentity but the same graph', () => {
  const lf = analyze({ 'src/app.ts': [BASE, HEAD] });
  const crlf = analyze({ 'src/app.ts': [toCrlf(BASE), toCrlf(HEAD)] });
  assert.equal(lf.result.outcome, 'completed');
  assert.equal(crlf.result.outcome, 'completed');
  assert.notEqual(lf.result.evidence.sourceState.contentIdentity, crlf.result.evidence.sourceState.contentIdentity);
  assert.deepEqual(crlf.result.evidence.technicalGraph.entities, lf.result.evidence.technicalGraph.entities);
  assert.deepEqual(crlf.result.evidence.technicalGraph.relations, lf.result.evidence.technicalGraph.relations);
  // Change snippets keep raw bytes (including \r), so compare which entities changed, not the snippets.
  const ids = (r: typeof lf) => r.result.evidence.changedEntities.map(item => item.entity.id);
  assert.deepEqual(ids(crlf), ids(lf));
});

test('paths: evidence uses "/" separators only', () => {
  const { result } = analyze({ 'src/deep/nested/app.ts': [BASE, HEAD] });
  assert.deepEqual(result.technicalGraph.analyzedFiles, ['src/deep/nested/app.ts']);
  assert.ok(!JSON.stringify(result.evidence).includes('\\\\'), 'evidence must not contain backslash separators');
});

test('sort: mixed-case paths are ordered by code point, not by locale', () => {
  const { result } = analyze({
    'src/util.ts': [BASE, HEAD],
    'src/Zeta.ts': ['export function zeta(): number { return 1; }\n', 'export function zeta(): number { return 2; }\n'],
    'src/Alpha.ts': ['export function alpha(): number { return 1; }\n', 'export function alpha(): number { return 2; }\n'],
    'src/beta.ts': ['export function beta(): number { return 1; }\n', 'export function beta(): number { return 2; }\n'],
  });
  assert.deepEqual(result.technicalGraph.analyzedFiles, ['src/Alpha.ts', 'src/Zeta.ts', 'src/beta.ts', 'src/util.ts']);
});

test('unicode: NFC and NFD file names each give a stable identity', () => {
  const nfc = 'src/café.ts';
  const nfd = 'src/café.ts';
  for (const name of [nfc, nfd]) {
    const first = analyze({ [name]: [BASE, HEAD] });
    const second = analyze({ [name]: [BASE, HEAD] });
    assert.equal(first.result.outcome, 'completed');
    assert.equal(first.result.technicalGraph.analyzedFiles.length, 1);
    assert.equal(first.identity, second.identity);
  }
});

test('golden hash: the same fixture gives the same identity hash on every OS', () => {
  const { result, identity } = analyze({ 'src/app.ts': [BASE, HEAD] });
  assert.equal(result.outcome, 'completed');
  assert.equal(identity, GOLDEN_IDENTITY,
    'If this changed on purpose (analyzer version or evidence shape), update GOLDEN_IDENTITY. If it differs only on one OS, that is a determinism bug.');
});

const GOLDEN_IDENTITY = '349f7f61bb892c0769b708869559b43fd33e7c339d18e1b138116ee3dfc5c570';
