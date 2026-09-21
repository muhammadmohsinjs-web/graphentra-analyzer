import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  MAX_BLAST_DEPTH,
  analyzeRepository,
  buildImpact,
  extractTechnicalGraph,
  getBlastRadiusPaths,
  getCallers,
} from '../src/index';

import { createRepo as createDisposableGitRepo } from './helpers/git-fixture';

test('characterization: entity IDs, function extraction, and scope preservation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-char-entity-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'sample.ts'),
      `// Standalone functions
export function computeTotal(a: number, b: number): number {
  return a + b;
}

function helper(val: number): number {
  return val * 2;
}

// Arrow functions and class methods (should NOT be extracted as entities)
export const arrowFunc = (x: number) => x + 1;

export class Calculator {
  method(n: number): number {
    return helper(n);
  }
}
`,
      'utf8',
    );

    const { entities, entityById } = extractTechnicalGraph({
      projectRoot: dir,
      headSha: '0000000000000000000000000000000000000000',
    });

    const entityIds = entities.map(e => e.id).sort();
    assert.deepEqual(entityIds, ['src/sample.ts#computeTotal', 'src/sample.ts#helper']);

    const computeTotal = entityById.get('src/sample.ts#computeTotal');
    assert.ok(computeTotal);
    assert.equal(computeTotal.kind, 'function');
    assert.equal(computeTotal.name, 'computeTotal');
    assert.equal(computeTotal.file, 'src/sample.ts');
    assert.equal(computeTotal.startLine, 2);
    assert.equal(computeTotal.endLine, 4);

    const helperEntity = entityById.get('src/sample.ts#helper');
    assert.ok(helperEntity);
    assert.equal(helperEntity.name, 'helper');
    assert.equal(helperEntity.startLine, 6);
    assert.equal(helperEntity.endLine, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('characterization: graph direction and caller resolution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-char-graph-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'calls.ts'),
      `export function leaf(): string {
  return 'leaf';
}

export function intermediate(): string {
  return leaf();
}

export function root(): string {
  return intermediate();
}
`,
      'utf8',
    );

    const { relations, reverseAdjacency, entityById } = extractTechnicalGraph({
      projectRoot: dir,
      headSha: '0000000000000000000000000000000000000000',
    });

    // Relations direction: from caller to callee
    const simplifiedRelations = relations.map(r => ({ from: r.from, to: r.to, type: r.type }));
    assert.deepEqual(simplifiedRelations, [
      {
        from: 'src/calls.ts#intermediate',
        to: 'src/calls.ts#leaf',
        type: 'CALLS',
      },
      {
        from: 'src/calls.ts#root',
        to: 'src/calls.ts#intermediate',
        type: 'CALLS',
      },
    ]);

    // Reverse adjacency: leaf has caller intermediate, intermediate has caller root
    const leafCallers = getCallers('src/calls.ts#leaf', reverseAdjacency, entityById);
    assert.equal(leafCallers.length, 1);
    assert.equal(leafCallers[0].id, 'src/calls.ts#intermediate');

    const intermediateCallers = getCallers('src/calls.ts#intermediate', reverseAdjacency, entityById);
    assert.equal(intermediateCallers.length, 1);
    assert.equal(intermediateCallers[0].id, 'src/calls.ts#root');

    const rootCallers = getCallers('src/calls.ts#root', reverseAdjacency, entityById);
    assert.equal(rootCallers.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('characterization: alternative impact paths and terminal dependents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-char-alt-'));
  try {
    // Diamond:
    // root calls branchA, root calls branchB
    // branchA calls leaf, branchB calls leaf
    // leaf is changed; both branchA and branchB are direct dependents, root is indirect dependent via 2 paths
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'diamond.ts'),
      `export function leaf(): number {
  return 42;
}

export function branchA(): number {
  return leaf() + 1;
}

export function branchB(): number {
  return leaf() + 2;
}

export function root(): number {
  return branchA() + branchB();
}
`,
      'utf8',
    );

    const { reverseAdjacency, entityById } = extractTechnicalGraph({
      projectRoot: dir,
      headSha: '0000000000000000000000000000000000000000',
    });

    const leafEntity = entityById.get('src/diamond.ts#leaf')!;
    const impact = buildImpact(
      {
        entity: leafEntity,
        change: {
          file: 'src/diamond.ts',
          changedLines: [2],
          addedCode: ['  return 100;'],
          removedCode: ['  return 42;'],
          diff: '',
        },
      },
      reverseAdjacency,
      entityById,
    );

    assert.equal(impact.blastRadius.totalAffectedEntities, 3);
    const affectedIds = impact.blastRadius.entities.map(e => e.id).sort();
    assert.deepEqual(affectedIds, [
      'src/diamond.ts#branchA',
      'src/diamond.ts#branchB',
      'src/diamond.ts#root',
    ]);

    // Direct dependents (depth 1)
    const directIds = impact.directDependents.map(e => e.id).sort();
    assert.deepEqual(directIds, ['src/diamond.ts#branchA', 'src/diamond.ts#branchB']);

    // Terminal dependents (entities with 0 callers)
    const terminalIds = impact.terminalDependents.map(e => e.id);
    assert.deepEqual(terminalIds, ['src/diamond.ts#root']);

    // Impact paths: leaf has 4 paths (branchA, branchB, branchA->root, branchB->root)
    assert.equal(impact.blastRadius.paths.length, 4);
    const pathStrings = impact.blastRadius.paths
      .map(p => p.path.map(e => e.name).join(' -> '))
      .sort();
    assert.deepEqual(pathStrings, [
      'leaf -> branchA',
      'leaf -> branchA -> root',
      'leaf -> branchB',
      'leaf -> branchB -> root',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('characterization: depth-six traversal limit and cycle handling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-char-depth-'));
  try {
    // Chain of 8 functions:
    // f7 -> f6 -> f5 -> f4 -> f3 -> f2 -> f1 -> f0
    // plus a cycle: f1 -> f2 -> f1
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'chain.ts'),
      `export function f0(): number { return 0; }
export function f1(): number { return f0() + f2(); }
export function f2(): number { return f1() > 0 ? f1() : 2; }
export function f3(): number { return f2(); }
export function f4(): number { return f3(); }
export function f5(): number { return f4(); }
export function f6(): number { return f5(); }
export function f7(): number { return f6(); }
`,
      'utf8',
    );

    const { reverseAdjacency, entityById } = extractTechnicalGraph({
      projectRoot: dir,
      headSha: '0000000000000000000000000000000000000000',
    });

    assert.equal(MAX_BLAST_DEPTH, 6);

    const paths = getBlastRadiusPaths('src/chain.ts#f0', reverseAdjacency, entityById, MAX_BLAST_DEPTH);
    const maxPathDepth = Math.max(...paths.map(p => p.depth));
    assert.equal(maxPathDepth, 6, 'Should reach depth 6');

    const reachedTargets = new Set(paths.map(p => p.target.name));
    assert.ok(reachedTargets.has('f1'), 'Depth 1 reachable');
    assert.ok(reachedTargets.has('f2'), 'Depth 2 reachable');
    assert.ok(reachedTargets.has('f3'), 'Depth 3 reachable');
    assert.ok(reachedTargets.has('f4'), 'Depth 4 reachable');
    assert.ok(reachedTargets.has('f5'), 'Depth 5 reachable');
    assert.ok(reachedTargets.has('f6'), 'Depth 6 reachable');
    assert.equal(reachedTargets.has('f7'), false, 'Depth 7 must NOT be reachable due to MAX_BLAST_DEPTH');

    // Cycle detection check: no path contains duplicate entities
    for (const p of paths) {
      const ids = p.path.map(e => e.id);
      const unique = new Set(ids);
      assert.equal(ids.length, unique.size, `Path must not contain duplicate entities: ${ids.join(', ')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('characterization: analyzeRepository on disposable Git repository with explicit before/after commits', () => {
  const repo = createDisposableGitRepo();
  try {
    const baseCode = `export function getPrice(base: number): number {
  return base * 1.1;
}

export function calculateOrder(): number {
  return getPrice(100);
}
`;
    const baseSha = repo.commitFile('src/order.ts', baseCode, 'Initial commit');

    const modifiedCode = `export function getPrice(base: number): number {
  return base * 1.2;
}

export function calculateOrder(): number {
  return getPrice(100);
}
`;
    const headSha = repo.commitFile('src/order.ts', modifiedCode, 'Update tax rate');

    const result = analyzeRepository({
      target: repo.dir,
      comparison: {
        mode: 'commit',
        base: baseSha,
        head: headSha,
      },
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(result.changedEntities.length, 1);
    assert.equal(result.changedEntities[0].entity.id, 'src/order.ts#getPrice');
    assert.equal(result.impacts.length, 1);
    assert.equal(result.impacts[0].directDependents.length, 1);
    assert.equal(result.impacts[0].directDependents[0].id, 'src/order.ts#calculateOrder');
    assert.ok(result.evidence);
    assert.equal(result.evidence.outcome, 'completed');
  } finally {
    repo.cleanup();
  }
});
