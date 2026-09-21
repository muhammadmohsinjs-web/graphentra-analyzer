import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ANALYZER_VERSION,
  MAX_BLAST_DEPTH,
  analyzeRepository,
  createRepositoryContext,
  extractTechnicalGraph,
  parseCliOptions,
} from '../src/index';

test('importing analyzer index is side-effect-free and exports expected API', () => {
  assert.equal(typeof analyzeRepository, 'function');
  assert.equal(typeof extractTechnicalGraph, 'function');
  assert.equal(typeof createRepositoryContext, 'function');
  assert.equal(typeof parseCliOptions, 'function');
  assert.equal(ANALYZER_VERSION, '0.4.0');
  assert.equal(MAX_BLAST_DEPTH, 6);
});

test('analyzeRepository handles clean disposable repository without crashing', () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-safety-test-'));
  const dir = fs.realpathSync(rawDir);
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'user.email', 'test@example.com']);

    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export function hello(): string { return "world"; }', 'utf8');
    git(['add', '.']);
    git(['commit', '-m', 'Initial commit']);

    const result = analyzeRepository({
      target: dir,
      comparison: {
        mode: 'working-tree',
      },
    });

    assert.ok(result);
    assert.ok(result.outcome);
    assert.ok(result.technicalGraph);
    assert.ok(result.evidence);
    assert.equal(result.technicalGraph.schemaVersion, '1.0');
    assert.equal(result.technicalGraph.capabilities.maxBlastDepth, 6);
    assert.equal(result.evidence.artifactKind, 'graphentra-evidence');
    assert.equal(result.evidence.schemaVersion, '2.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
