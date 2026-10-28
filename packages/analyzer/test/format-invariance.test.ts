import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { analyzeRepository } from '../src/analyze';
import { createRepo } from './helpers/git-fixture';

/**
 * P3-7 exit gate: a formatting-only rewrite of every source file in a fixture yields zero impact.
 * The rewrite re-prints each file with the TypeScript printer (new indentation, line breaks and
 * semicolons) behind a banner comment, so it is semantics-preserving but touches most lines.
 */
const FIXTURES_ROOT = path.resolve(__dirname, '../../../fixtures');
const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

function collect(root: string, rel: string, into: Record<string, string>) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) collect(root, relPath, into);
    else into[relPath] = fs.readFileSync(path.join(root, relPath), 'utf8');
  }
}

function readFixture(fixture: string): Record<string, string> {
  const root = path.join(FIXTURES_ROOT, fixture);
  const files: Record<string, string> = {};
  for (const dir of ['src', 'tests']) collect(root, dir, files);
  for (const name of ['package.json', 'tsconfig.json']) files[name] = fs.readFileSync(path.join(root, name), 'utf8');
  return files;
}

function reformat(file: string, text: string): string {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const printed = ts.createPrinter({ removeComments: false, newLine: ts.NewLineKind.LineFeed }).printFile(sourceFile);
  return `/* reformatted */\n\n${printed}`;
}

const fixtures = fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

for (const fixture of fixtures) {
  test(`format-only rewrite of ${fixture} yields zero impact`, () => {
    const repo = createRepo('graphentra-format-');
    try {
      const base = readFixture(fixture);
      for (const [file, content] of Object.entries(base)) {
        fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, file), content);
      }
      repo.git(['add', '-A']);
      repo.git(['commit', '-m', 'base']);
      const baseSha = repo.git(['rev-parse', 'HEAD']);

      let rewritten = 0;
      for (const [file, content] of Object.entries(base)) {
        if (!SOURCE_FILE.test(file)) continue;
        const next = reformat(file, content);
        if (next !== content) rewritten++;
        fs.writeFileSync(path.join(repo.dir, file), next);
      }
      assert.ok(rewritten > 0, 'the rewrite must change at least one file');
      repo.git(['add', '-A']);
      repo.git(['commit', '-m', 'head']);
      const headSha = repo.git(['rev-parse', 'HEAD']);

      const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base: baseSha, head: headSha }, engine: 'extended' });
      assert.equal(result.outcome, 'completed');
      assert.ok(result.changedEntities.some(changed => changed.entity.kind !== 'module'), 'the rewrite must touch real entities');
      const notCosmetic = result.changedEntities.filter(changed => !changed.changeClasses?.includes('cosmetic'))
        .map(changed => `${changed.entity.id}: ${changed.changeClasses?.join(',')}`);
      assert.deepEqual(notCosmetic, []);
      assert.deepEqual(result.impacts.filter(impact => impact.blastRadius.totalAffectedEntities > 0).map(impact => impact.changedEntity.id), []);
      assert.equal(result.impacts.length, 0);
      assert.equal(result.evidence.skippedEntities?.length, result.changedEntities.length);
    } finally {
      repo.cleanup();
    }
  });
}
