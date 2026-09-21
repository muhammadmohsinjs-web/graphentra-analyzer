import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ANALYZER_VERSION } from '../src/contracts';

const CLI_PATH = path.resolve(__dirname, '../dist/cli.js');

function runAnalyzerCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

import { createRepo } from './helpers/git-fixture';

test('CLI safety: --help and --version options return zero exit code', () => {
  const helpResult = runAnalyzerCli(['--help']);
  assert.equal(helpResult.status, 0);
  assert.match(helpResult.stdout, /Graphentra Analyzer/);

  const shortHelp = runAnalyzerCli(['-h']);
  assert.equal(shortHelp.status, 0);

  const versionResult = runAnalyzerCli(['--version']);
  assert.equal(versionResult.status, 0);
  assert.equal(versionResult.stdout.trim(), ANALYZER_VERSION);

  const shortVersion = runAnalyzerCli(['-v']);
  assert.equal(shortVersion.status, 0);
  assert.equal(shortVersion.stdout.trim(), ANALYZER_VERSION);
});

test('CLI safety: invalid arguments exit with nonzero status', () => {
  const res = runAnalyzerCli(['--target', '/non/existent/target/path']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /INVALID_TARGET/);
});

test('CLI safety: writes evidence to exact file path specified by --output', () => {
  const repo = createRepo('graphentra-custom-output-');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-out-'));
  try {
    repo.commitFile('src/calc.ts', 'export function add(a: number, b: number) { return a + b; }', 'c1');
    const customEvidencePath = path.join(outDir, 'my-evidence.json');

    const res = runAnalyzerCli([
      '--target',
      repo.dir,
      '--working-tree',
      '--output',
      customEvidencePath,
    ]);

    assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
    assert.equal(fs.existsSync(customEvidencePath), true);

    const content = JSON.parse(fs.readFileSync(customEvidencePath, 'utf8'));
    assert.equal(content.artifactKind, 'graphentra-evidence');
    assert.equal(content.schemaVersion, '2.0');
    assert.equal(content.outcome, 'no_changes');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('CLI safety: replaces stale evidence on empty outcome', () => {
  const repo = createRepo('graphentra-replace-stale-');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-stale-out-'));
  try {
    const c1 = repo.commitFile('src/calc.ts', 'export function add(a: number, b: number) { return a + b; }', 'c1');
    const c2 = repo.commitFile('src/calc.ts', 'export function add(a: number, b: number) { return a + b + 1; }', 'c2');
    const evidencePath = path.join(outDir, 'evidence.json');

    // Run 1: completed with 1 changed function
    const res1 = runAnalyzerCli([
      '--target',
      repo.dir,
      '--base',
      c1,
      '--head',
      c2,
      '--output',
      evidencePath,
    ]);
    assert.equal(res1.status, 0);
    const ev1 = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(ev1.outcome, 'completed');
    assert.equal(ev1.changedEntities.length, 1);

    // Run 2: compare c2 to c2 (no changes)
    const res2 = runAnalyzerCli([
      '--target',
      repo.dir,
      '--base',
      c2,
      '--head',
      c2,
      '--output',
      evidencePath,
    ]);
    assert.equal(res2.status, 0);
    const ev2 = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(ev2.outcome, 'no_changes');
    assert.equal(ev2.changedEntities.length, 0);
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('CLI safety: supports an extensionless output file separate from target', () => {
  const repo = createRepo('graphentra-sep-out-');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-writable-out-'));
  try {
    repo.commitFile('src/main.ts', 'export function main() { return 42; }', 'Initial');
    const res = runAnalyzerCli([
      '--target',
      repo.dir,
      '--working-tree',
      '--output',
      path.join(outDir, 'evidence'),
    ]);

    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(path.join(outDir, 'evidence')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'technical-graph.json')), false);
    // Verify target directory has no .graphentra created
    assert.equal(fs.existsSync(path.join(repo.dir, '.graphentra')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
