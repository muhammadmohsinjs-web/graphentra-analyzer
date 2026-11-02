import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { computeDeterministicEvidenceIdentity } from '../src/deterministic';
import { formatDeterministicMarkdown } from '../src/output';
import { validateEvidenceEnvelope } from '../src/validator';
import type { AnalyzeOptions, AnalyzeResult } from '../src/contracts';
import { createRepo } from './helpers/git-fixture';

/** Phase 4 wiring: every new evidence field and report section, on disposable repos built from fixtures. */
const FIXTURES_ROOT = path.resolve(__dirname, '../../../fixtures');

function copyDir(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(path.join(from, entry.name), path.join(to, entry.name));
    else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
  }
}

/** Commits the fixture as base, applies `edit` (relative path to content) and commits it as head. */
function scenario(fixture: string, edit: (read: (file: string) => string) => Record<string, string | Buffer>, extra: Partial<AnalyzeOptions> = {}) {
  const repo = createRepo('graphentra-phase4-');
  try {
    copyDir(path.join(FIXTURES_ROOT, fixture), repo.dir);
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    const base = repo.git(['rev-parse', 'HEAD']);
    for (const [file, content] of Object.entries(edit(file => fs.readFileSync(path.join(repo.dir, file), 'utf8')))) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, file), content);
    }
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'head']);
    const head = repo.git(['rev-parse', 'HEAD']);
    const run = () => analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'extended', ...extra });
    const first = run();
    return { first, second: run(), legacy: analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'legacy' }) };
  } finally { repo.cleanup(); }
}

const sorted = <T>(items: T[], key: (item: T) => string[]) => items.every((item, i) => {
  if (i === 0) return true;
  const a = key(items[i - 1]);
  const b = key(item);
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k];
  return true;
});

function assertCommon(first: AnalyzeResult, second: AnalyzeResult) {
  assert.equal(validateEvidenceEnvelope(first.evidence).valid, true, JSON.stringify(validateEvidenceEnvelope(first.evidence)));
  assert.ok(Array.isArray(first.evidence.frontier), 'frontier is always present in extended evidence');
  assert.ok(first.evidence.coverage, 'coverage is always present in extended evidence');
  assert.ok(sorted(first.evidence.frontier!, item => [item.file, String(item.line).padStart(8, '0'), item.reason, item.entityId]));
  assert.ok(sorted(first.evidence.coverage!.byLanguage, row => [row.key]));
  assert.ok(sorted(first.evidence.coverage!.byDirectory, row => [row.key]));
  assert.ok(sorted(first.evidence.coverage!.skippedFiles, item => [item.file]));
  assert.equal(first.evidence.sourceState.contentIdentity, second.evidence.sourceState.contentIdentity);
  assert.equal(computeDeterministicEvidenceIdentity(first.evidence), computeDeterministicEvidenceIdentity(second.evidence));
  assert.deepEqual(first.evidence.frontier, second.evidence.frontier);
}

test('dynamic patterns: every frontier reason is reported for entities in the blast radius', () => {
  const { first, second, legacy } = scenario('dynamic-patterns', read => ({ 'src/core.ts': read('src/core.ts').replace('value.trim()', 'value.trim().toLowerCase()') }));
  assertCommon(first, second);
  assert.deepEqual(first.evidence.frontier!.map(item => [item.entityId.split('#')[1], item.reason]), [
    ['runEval', 'eval'], ['loadPlugin', 'dynamic_require'], ['loadLazy', 'dynamic_import'],
    ['dispatch', 'computed_member_call'], ['callAny', 'any_typed_call'], ['runViaInterface', 'interface_dispatch'],
  ]);
  assert.equal(first.evidence.coverage!.frontierTotal, 6);
  // Rows count changed files only; the frontier sites live in an unchanged file, so they show only in frontierTotal (D12).
  assert.deepEqual(first.evidence.coverage!.byLanguage.map(row => [row.key, row.frontierCount]), [['typescript', 0]]);
  const markdown = formatDeterministicMarkdown(first);
  assert.match(markdown, /## Where analysis stopped\n\n- src\/dynamic\.ts:8 eval\n/);
  assert.match(markdown, /- src\/dynamic\.ts:32 interface_dispatch\n/);
  assert.match(markdown, /### Proven impact/);
  assert.match(markdown, /## Coverage/);
  assert.equal(legacy.evidence.frontier, undefined);
  assert.equal(legacy.evidence.coverage, undefined);
  assert.doesNotMatch(formatDeterministicMarkdown(legacy), /Where analysis stopped|## Coverage|Proven impact|Non-TypeScript/);
});

test('frontier is limited to changed and affected entities; the repository total goes to coverage', () => {
  const { first } = scenario('dynamic-patterns', read => ({ 'src/dynamic.ts': read('src/dynamic.ts').replace("helper('static')", "helper('static!')") }));
  assert.deepEqual(first.evidence.frontier, []);
  assert.equal(first.evidence.coverage!.frontierTotal, 6);
});

test('mixed changes: typed non-TypeScript diagnostics replace OUTSIDE_SUPPORTED_SCOPE and coverage lists the gaps', () => {
  const { first, second, legacy } = scenario('mixed-changes', read => ({
    'src/greeting.ts': read('src/greeting.ts').replace('Hello, ', 'Hi, '),
    'package.json': read('package.json').replace('"left-pad": "1.2.0"', '"left-pad": "1.3.0"').replace('"zod": "3.22.0"', '"zod": "3.23.0"'),
    'prisma/migrations/20240101000000_add_users/migration.sql': 'CREATE TABLE "User" ("id" SERIAL PRIMARY KEY);\n',
    '.env.example': 'DATABASE_URL=postgres://localhost/app\n',
    'scripts/report.py': 'def report():\n    return "ok"\n',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  }));
  assertCommon(first, second);
  const typed = first.evidence.diagnostics.filter(item => item.file !== undefined && ['DEPENDENCY_CHANGE', 'SCHEMA_CHANGE', 'ENV_CONFIG_CHANGE', 'OTHER'].includes(item.code));
  assert.deepEqual(typed.map(item => [item.code, item.file, item.severity]), [
    ['ENV_CONFIG_CHANGE', '.env.example', 'warning'],
    ['DEPENDENCY_CHANGE', 'package.json', 'warning'],
    ['SCHEMA_CHANGE', 'prisma/migrations/20240101000000_add_users/migration.sql', 'warning'],
    ['OTHER', 'scripts/report.py', 'warning'],
  ]);
  assert.match(typed[1].message, /changed left-pad 1\.2\.0 → 1\.3\.0, zod 3\.22\.0 → 3\.23\.0/);
  assert.ok(!first.evidence.diagnostics.some(item => item.code === 'OUTSIDE_SUPPORTED_SCOPE'));
  assert.ok(legacy.evidence.diagnostics.some(item => item.code === 'OUTSIDE_SUPPORTED_SCOPE'));
  const coverage = first.evidence.coverage!;
  assert.deepEqual(coverage.skippedFiles.map(item => item.reason), ['unsupported_language', 'unsupported_language', 'unsupported_language', 'unsupported_language']);
  assert.deepEqual(coverage.byLanguage.find(row => row.key === 'typescript'), { key: 'typescript', changedLines: 1, attributedLines: 1, ratio: 1, frontierCount: 0 });
  assert.equal(coverage.byLanguage.find(row => row.key === 'python')?.attributedLines, 0);
  const markdown = formatDeterministicMarkdown(first);
  assert.match(markdown, /## Non-TypeScript changes\n\n### DEPENDENCY_CHANGE\n\n- package\.json: changed left-pad/);
  assert.ok(markdown.indexOf('### DEPENDENCY_CHANGE') < markdown.indexOf('### SCHEMA_CHANGE'));
  assert.ok(markdown.indexOf('### SCHEMA_CHANGE') < markdown.indexOf('### ENV_CONFIG_CHANGE'), 'classes follow D11 precedence order');
  assert.doesNotMatch(markdown, /\[WARNING\] DEPENDENCY_CHANGE/);
  assert.match(markdown, /## Coverage[\s\S]*### Skipped files\n\n- \.env\.example \(unsupported_language\)/);
});

test('hub: editing a utility with 30 callers records the hub and reports it', () => {
  const { first, second } = scenario('hub', read => ({ 'src/format.ts': read('src/format.ts').replace('toFixed(2)', 'toFixed(3)') }));
  assertCommon(first, second);
  const [impact] = first.impacts;
  assert.deepEqual(impact.blastRadius.hubs, [{ entityId: 'src/format.ts#formatValue', fanIn: 30, reach: 31 }]);
  assert.equal(impact.blastRadius.truncated, true);
  assert.match(formatDeterministicMarkdown(first), /- Changed a hub used by 30 callers \(reach 31\)/);
  assert.ok(first.diagnostics.some(item => item.code === 'BLAST_RADIUS_TRUNCATED' && /hub/.test(item.message)));
});

test('hub and depth options reach the traversal', () => {
  const edit = (read: (file: string) => string) => ({ 'src/format.ts': read('src/format.ts').replace('toFixed(2)', 'toFixed(3)') });
  const raised = scenario('hub', edit, { hubThreshold: 100 }).first;
  assert.equal(raised.impacts[0].blastRadius.hubs, undefined);
  assert.equal(raised.impacts[0].blastRadius.truncated, false);
  assert.equal(raised.impacts[0].blastRadius.totalAffectedEntities, 31);
  const shallow = scenario('hub', edit, { hubThreshold: 100, maxDepth: 1 }).first;
  assert.equal(shallow.impacts[0].blastRadius.totalAffectedEntities, 30);
  assert.throws(() => analyzeRepository({ target: '.', comparison: { mode: 'working-tree' }, hubThreshold: 0 }), { code: 'INVALID_OPTIONS' });
});

test('input skips become sorted warnings with codes, and skipped files leave analyzedFiles', () => {
  const { first } = scenario('mixed-changes', read => ({
    'src/greeting.ts': read('src/greeting.ts').replace('Hello, ', 'Hi, '),
    'src/big.ts': `export const big = "${'x'.repeat(3 * 1024 * 1024)}";`,
    'src/binary.ts': Buffer.from([0x65, 0x78, 0x00, 0x00, 0x01]),
    'src/bad.ts': Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0xfe, 0x0a]),
    'src/deep.ts': `export const deep = ${'('.repeat(600)}1${')'.repeat(600)};`,
  }));
  const skips = first.evidence.diagnostics.filter(item => ['FILE_TOO_LARGE', 'BINARY_FILE', 'INVALID_ENCODING', 'PARSE_FAILED'].includes(item.code));
  assert.deepEqual(skips.map(item => [item.code, item.file, item.severity]), [
    ['INVALID_ENCODING', 'src/bad.ts', 'warning'],
    ['FILE_TOO_LARGE', 'src/big.ts', 'warning'],
    ['BINARY_FILE', 'src/binary.ts', 'warning'],
    ['PARSE_FAILED', 'src/deep.ts', 'warning'],
  ]);
  for (const file of ['src/bad.ts', 'src/big.ts', 'src/binary.ts', 'src/deep.ts']) assert.ok(!first.technicalGraph.analyzedFiles.includes(file));
  assert.deepEqual(first.evidence.coverage!.skippedFiles.filter(item => item.file.startsWith('src/')).map(item => [item.file, item.reason]), [
    ['src/bad.ts', 'invalid_encoding'], ['src/big.ts', 'too_large'], ['src/binary.ts', 'binary'], ['src/deep.ts', 'parse_failure'],
  ]);
  assert.equal(validateEvidenceEnvelope(first.evidence).valid, true);
});

test('a base source over the input limit reads as absent and is reported once', () => {
  const repo = createRepo('graphentra-phase4-base-');
  try {
    repo.commitFile('tsconfig.json', '{"compilerOptions":{"target":"ES2022","module":"CommonJS"}}');
    repo.commitFile('src/a.ts', `export function a() { return 1; }\n// ${'x'.repeat(3 * 1024 * 1024)}\n`);
    const base = repo.commitFile('src/b.ts', 'export function b() { return 1; }\n');
    const head = repo.commitFile('src/a.ts', 'export function a() { return 2; }\n');
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'extended' });
    assert.deepEqual(result.evidence.diagnostics.filter(item => item.code === 'FILE_TOO_LARGE').map(item => item.file), ['src/a.ts']);
    assert.equal(validateEvidenceEnvelope(result.evidence).valid, true);
    assert.ok(result.technicalGraph.analyzedFiles.includes('src/a.ts'), 'the head file itself is small and stays analyzed');
  } finally { repo.cleanup(); }
});
