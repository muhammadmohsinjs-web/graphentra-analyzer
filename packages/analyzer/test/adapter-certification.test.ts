import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/index';
import { createRepo } from './helpers/git-fixture';

/**
 * Adapter certification: each framework fixture under fixtures/frameworks is analyzed and its surfaces
 * are compared with a golden, and every row marked "yes" in the fixture's EXPECTATIONS.md must exist.
 * Regenerate goldens deliberately with: UPDATE_GOLDENS=1 npx tsx --test test/adapter-certification.test.ts
 */
const FRAMEWORKS_ROOT = path.join(__dirname, 'fixtures/frameworks');
const GOLDEN_DIR = path.join(__dirname, 'golden/adapters');
const UPDATE = process.env.UPDATE_GOLDENS === '1';
const FIXTURES = ['nextjs-14', 'nextjs-13', 'express-4', 'express-5'];

function copyDir(target: string, source: string, relative = ''): void {
  for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(path.join(target, child), { recursive: true }); copyDir(target, source, child); }
    else fs.copyFileSync(path.join(source, child), path.join(target, child));
  }
}

/** Rows of the form `| surface id | kind | file | detected? |`; only the first table (before "Known not detected") counts. */
function expectedRows(fixture: string): Array<{ id: string; kind: string; file: string; detected: string }> {
  const text = fs.readFileSync(path.join(FRAMEWORKS_ROOT, fixture, 'EXPECTATIONS.md'), 'utf8');
  const rows: Array<{ id: string; kind: string; file: string; detected: string }> = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replace(/^`|`$/g, ''));
    if (cells.length !== 4 || cells[0] === 'expected surface id' || /^-+$/.test(cells[0]!)) continue;
    rows.push({ id: cells[0]!, kind: cells[1]!, file: cells[2]!, detected: cells[3]!.toLowerCase() });
  }
  return rows;
}

for (const fixture of FIXTURES) {
  test(`adapter certification: ${fixture}`, () => {
    const repo = createRepo('graphentra-adapter-');
    try {
      copyDir(repo.dir, path.join(FRAMEWORKS_ROOT, fixture));
      fs.rmSync(path.join(repo.dir, 'EXPECTATIONS.md'), { force: true });
      repo.git(['add', '.']);
      repo.git(['commit', '-m', 'initial']);
      const trivial = path.join(repo.dir, 'trivial.ts');
      fs.writeFileSync(trivial, 'export const certificationProbe = 1;\n');
      const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
      const surfaces = result.applicationMap.surfaces
        .map(s => ({ id: s.id, kind: s.kind, route: s.route, method: s.method ?? null, source: s.source,
          file: s.file, line: s.line, entryEntityIds: s.entryEntityIds }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const goldenFile = path.join(GOLDEN_DIR, `${fixture}.json`);
      if (UPDATE) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(goldenFile, `${JSON.stringify(surfaces, null, 2)}\n`);
      }
      assert.ok(fs.existsSync(goldenFile), `Missing golden ${goldenFile}. Run with UPDATE_GOLDENS=1 to create it.`);
      assert.deepEqual(surfaces, JSON.parse(fs.readFileSync(goldenFile, 'utf8')));

      const byId = new Map(surfaces.map(s => [s.id, s]));
      const rows = expectedRows(fixture);
      assert.ok(rows.length > 0, `${fixture}/EXPECTATIONS.md has no table rows`);
      for (const row of rows) {
        const found = byId.get(row.id);
        if (row.detected === 'yes') {
          assert.ok(found, `${fixture}: expected surface ${row.id} was not detected`);
          assert.equal(found.kind, row.kind, `${fixture}: kind of ${row.id}`);
          assert.equal(found.file, row.file, `${fixture}: file of ${row.id}`);
        } else {
          assert.equal(found, undefined, `${fixture}: ${row.id} is marked "${row.detected}" but is now detected; update EXPECTATIONS.md`);
        }
      }
    } finally {
      repo.cleanup();
    }
  });
}
