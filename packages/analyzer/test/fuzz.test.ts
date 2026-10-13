import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { computeDeterministicEvidenceIdentity } from '../src/deterministic';
import { validateEvidenceEnvelope } from '../src/index';
import { readFixture } from './helpers/fixture-repo';
import { createRepo } from './helpers/git-fixture';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(source: string, random: () => number): string {
  let result = source;
  const deletions = 1 + Math.floor(random() * 20);
  for (let index = 0; index < deletions && result.length > 0; index++) {
    const position = Math.floor(random() * result.length);
    const length = random() < 0.5 ? 1 : 1 + Math.floor(random() * 10);
    result = result.slice(0, position) + result.slice(position + length);
  }
  return result;
}

test('fuzz: extended analysis of randomly corrupted files never throws and always validates', () => {
  const cases = Number(process.env.FUZZ_CASES ?? 100);
  const base = readFixture('modern-app');
  const sourceFiles = Object.keys(base).filter(file => /\.tsx?$/.test(file)).sort();
  const repo = createRepo('graphentra-fuzz-');
  try {
    for (const [file, content] of Object.entries(base)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, file), content);
    }
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    const analyze = () => analyzeRepository({
      target: repo.dir, comparison: { mode: 'working-tree', base: 'HEAD' }, engine: 'extended',
    });

    for (let index = 0; index < cases; index++) {
      const seed = 0x9e3779b1 + index;
      const random = mulberry32(seed);
      const file = sourceFiles[Math.floor(random() * sourceFiles.length)]!;
      const label = `seed=${seed} case=${index} file=${file}`;
      fs.writeFileSync(path.join(repo.dir, file), mutate(base[file]!, random));
      try {
        const result = analyze();
        assert.deepEqual(validateEvidenceEnvelope(result.evidence), { valid: true, errors: [] }, label);
        if (index % 10 === 0) {
          assert.equal(
            computeDeterministicEvidenceIdentity(analyze().evidence),
            computeDeterministicEvidenceIdentity(result.evidence),
            `non-deterministic identity: ${label}`,
          );
        }
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        fs.writeFileSync(path.join(repo.dir, file), base[file]!);
      }
    }
  } finally {
    repo.cleanup();
  }
});
