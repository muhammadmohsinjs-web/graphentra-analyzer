import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  DirtySourceError,
  RevisionError,
  analyzeRepository,
  computeDeterministicEvidenceIdentity,
} from '../src/index';

import { createRepo } from './helpers/git-fixture';

test('revision alignment: rejects wrong checkout head in commit mode', () => {
  const repo = createRepo('graphentra-wronghead-');
  try {
    const c1 = repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');
    const c2 = repo.commitFile('src/a.ts', 'export function a() { return 2; }', 'c2');
    const c3 = repo.commitFile('src/a.ts', 'export function a() { return 3; }', 'c3');

    // Currently checked out at c3 (HEAD).
    // Requesting commit comparison between c1 and c2 should fail because checkout is c3, not c2!
    assert.throws(
      () =>
        analyzeRepository({
          target: repo.dir,
          comparison: { mode: 'commit', base: c1, head: c2 },
        }),
      (err: any) => {
        return err instanceof RevisionError && err.code === 'REVISION_MISMATCH';
      },
    );
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: rejects dirty tracked source in commit mode', () => {
  const repo = createRepo('graphentra-dirtytracked-');
  try {
    const c1 = repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');
    const c2 = repo.commitFile('src/a.ts', 'export function a() { return 2; }', 'c2');

    // Introduce uncommitted change in tracked file
    fs.writeFileSync(path.join(repo.dir, 'src/a.ts'), 'export function a() { return 999; }', 'utf8');

    assert.throws(
      () =>
        analyzeRepository({
          target: repo.dir,
          comparison: { mode: 'commit', base: c1, head: c2 },
        }),
      (err: any) => {
        return err instanceof DirtySourceError && err.code === 'DIRTY_TRACKED_SOURCE';
      },
    );
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: rejects untracked source in commit mode', () => {
  const repo = createRepo('graphentra-dirtyuntracked-');
  try {
    const c1 = repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');
    const c2 = repo.commitFile('src/a.ts', 'export function a() { return 2; }', 'c2');

    // Add untracked TypeScript file
    fs.writeFileSync(path.join(repo.dir, 'src/untracked.ts'), 'export function b() { return 0; }', 'utf8');

    assert.throws(
      () =>
        analyzeRepository({
          target: repo.dir,
          comparison: { mode: 'commit', base: c1, head: c2 },
        }),
      (err: any) => {
        return err instanceof DirtySourceError && err.code === 'DIRTY_UNTRACKED_SOURCE';
      },
    );
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: rejects invalid or missing ref', () => {
  const repo = createRepo('graphentra-invalidref-');
  try {
    const c1 = repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');

    assert.throws(
      () =>
        analyzeRepository({
          target: repo.dir,
          comparison: { mode: 'commit', base: 'non_existent_branch_123', head: c1 },
        }),
      (err: any) => err instanceof RevisionError && err.code === 'INVALID_REVISION',
    );
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: working-tree mode allows tracked dirtiness and records content identity', () => {
  const repo = createRepo('graphentra-wt-');
  try {
    repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');
    // Dirty modification in working tree
    fs.writeFileSync(path.join(repo.dir, 'src/a.ts'), 'export function a() { return 2; }', 'utf8');

    const result = analyzeRepository({
      target: repo.dir,
      comparison: { mode: 'working-tree', base: 'HEAD' },
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(result.evidence.sourceState.isTrackedDirty, true);
    assert.ok(result.evidence.sourceState.contentIdentity);
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: nested target directory within repo', () => {
  const repo = createRepo('graphentra-nested-');
  try {
    const subTarget = path.join(repo.dir, 'packages', 'subpkg');
    fs.mkdirSync(path.join(subTarget, 'src'), { recursive: true });

    repo.commitFile('packages/subpkg/src/func.ts', 'export function foo() { return 1; }', 'c1');
    const c2 = repo.commitFile('packages/subpkg/src/func.ts', 'export function foo() { return 2; }', 'c2');

    const result = analyzeRepository({
      target: subTarget,
      comparison: { mode: 'working-tree' },
    });

    assert.equal(result.outcome, 'no_changes');
    assert.equal(result.evidence.target.targetPath, 'packages/subpkg');
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: target path containing spaces', () => {
  const rawBase = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra space test-'));
  const dir = fs.realpathSync(rawBase);
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'user.email', 'test@example.com']);

    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export function a() { return 1; }', 'utf8');
    git(['add', '.']);
    git(['commit', '-m', 'Initial']);

    const result = analyzeRepository({
      target: dir,
      comparison: { mode: 'working-tree' },
    });

    assert.ok(result);
    assert.equal(result.outcome, 'no_changes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revision alignment: environment variables do not override explicit library requests', () => {
  const repo = createRepo('graphentra-env-test-');
  try {
    const c1 = repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');
    const c2 = repo.commitFile('src/a.ts', 'export function a() { return 2; }', 'c2');

    // Poison environment variables
    const oldBase = process.env.BASE_SHA;
    const oldHead = process.env.HEAD_SHA;
    process.env.BASE_SHA = '0000000000000000000000000000000000000000';
    process.env.HEAD_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

    try {
      const result = analyzeRepository({
        target: repo.dir,
        comparison: { mode: 'commit', base: c1, head: c2 },
      });

      assert.equal(result.outcome, 'completed');
      assert.equal(result.evidence.comparison.resolvedBaseSha, c1);
      assert.equal(result.evidence.comparison.resolvedHeadSha, c2);
    } finally {
      if (oldBase !== undefined) process.env.BASE_SHA = oldBase;
      else delete process.env.BASE_SHA;
      if (oldHead !== undefined) process.env.HEAD_SHA = oldHead;
      else delete process.env.HEAD_SHA;
    }
  } finally {
    repo.cleanup();
  }
});

test('revision alignment: analyze A, then B, then A again; A deterministic fields match identically', () => {
  const repoA = createRepo('graphentra-repeat-a-');
  const repoB = createRepo('graphentra-repeat-b-');
  try {
    const cA1 = repoA.commitFile('src/a.ts', 'export function fnA() { return 1; }', 'cA1');
    const cA2 = repoA.commitFile('src/a.ts', 'export function fnA() { return 10; }', 'cA2');

    const cB1 = repoB.commitFile('src/b.ts', 'export function fnB() { return 2; }', 'cB1');
    const cB2 = repoB.commitFile('src/b.ts', 'export function fnB() { return 20; }', 'cB2');

    // 1. Analyze A
    const resA1 = analyzeRepository({
      target: repoA.dir,
      comparison: { mode: 'commit', base: cA1, head: cA2 },
    });
    const hashA1 = computeDeterministicEvidenceIdentity(resA1.evidence);

    // 2. Analyze B
    const resB = analyzeRepository({
      target: repoB.dir,
      comparison: { mode: 'commit', base: cB1, head: cB2 },
    });
    const hashB = computeDeterministicEvidenceIdentity(resB.evidence);
    assert.notEqual(hashA1, hashB, 'A and B must have different evidence hashes');

    // 3. Analyze A again
    const resA2 = analyzeRepository({
      target: repoA.dir,
      comparison: { mode: 'commit', base: cA1, head: cA2 },
    });
    const hashA2 = computeDeterministicEvidenceIdentity(resA2.evidence);

    assert.equal(hashA1, hashA2, 'Repeat analysis of A must match identically');
  } finally {
    repoA.cleanup();
    repoB.cleanup();
  }
});
