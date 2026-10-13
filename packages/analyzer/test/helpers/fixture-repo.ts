import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeRepository } from '../../src/analyze';
import type { AnalyzeResult, EngineProfile } from '../../src/contracts';
import { createRepo } from './git-fixture';

const FIXTURES_ROOT = path.resolve(__dirname, '../../../../fixtures');

export type Files = Record<string, string>;

function readDir(root: string, rel: string, files: Files) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) readDir(root, relPath, files);
    else files[relPath] = fs.readFileSync(path.join(root, relPath), 'utf8');
  }
}

export function readFixture(fixture: string): Files {
  const root = path.join(FIXTURES_ROOT, fixture);
  const files: Files = {};
  for (const dir of ['src', 'tests']) readDir(root, dir, files);
  for (const name of ['package.json', 'tsconfig.json']) files[name] = fs.readFileSync(path.join(root, name), 'utf8');
  return files;
}

export function replaceOnce(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `source no longer contains: ${from}`);
  return source.replace(from, to);
}

const DEFAULT_TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', jsx: 'react-jsx', strict: true, noEmit: true } });

function writeFiles(dir: string, files: Files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
}

/** Base files, optional edits (written over the base), then analyze. Mirrors the golden harness. */
function run(base: Files, edit: Files | undefined, removed: string[], engine: EngineProfile, mode: 'commit' | 'working-tree'): AnalyzeResult {
  const repo = createRepo('graphentra-fixture-');
  try {
    writeFiles(repo.dir, base);
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    const baseSha = repo.git(['rev-parse', 'HEAD']);
    const edits = edit ?? {};
    writeFiles(repo.dir, edits);
    for (const file of removed) fs.rmSync(path.join(repo.dir, file), { force: true });
    if (mode === 'working-tree') {
      return analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree', base: 'HEAD' }, engine });
    }
    let headSha = baseSha;
    if (Object.keys(edits).length > 0 || removed.length > 0) {
      repo.git(['add', '-A']);
      repo.git(['commit', '-m', 'head']);
      headSha = repo.git(['rev-parse', 'HEAD']);
    }
    return analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base: baseSha, head: headSha }, engine });
  } finally {
    repo.cleanup();
  }
}

export function analyzeFixture(options: {
  fixture: 'modern-app' | 'test-project';
  edits?: (files: Files) => Files;
  engine: EngineProfile;
  mode?: 'commit' | 'working-tree';
}): AnalyzeResult {
  const base = readFixture(options.fixture);
  return run(base, options.edits?.(base), [], options.engine, options.mode ?? 'commit');
}

/**
 * Inline mini-repo. `head` files are written over `base`; files in `base` but absent from `head`
 * stay unchanged, and `removed` deletes base files (for renames). A default tsconfig.json is added when none is given.
 */
export function analyzeSources(options: { base: Files; head: Files; engine: EngineProfile; removed?: string[]; defaultTsconfig?: boolean }): AnalyzeResult {
  const base: Files = { ...(options.defaultTsconfig === false ? {} : { 'tsconfig.json': DEFAULT_TSCONFIG }), ...options.base };
  return run(base, options.head, options.removed ?? [], options.engine, 'commit');
}
