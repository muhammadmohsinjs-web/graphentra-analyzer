import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { createRepo } from './helpers/git-fixture';

/**
 * Golden end-to-end snapshots: run the whole pipeline on a disposable git repo built from
 * fixtures/test-project and compare the normalized evidence with saved JSON.
 * Regenerate deliberately with: UPDATE_GOLDENS=1 npm test --workspace=@graphentra/analyzer
 */
const FIXTURES_ROOT = path.resolve(__dirname, '../../../fixtures');
const GOLDEN_DIR = path.join(__dirname, 'golden');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

type Files = Record<string, string>;

function readDir(root: string, rel: string, files: Files) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) readDir(root, relPath, files);
    else files[relPath] = fs.readFileSync(path.join(root, relPath), 'utf8');
  }
}

function readFixture(fixture: string): Files {
  const root = path.join(FIXTURES_ROOT, fixture);
  const files: Files = {};
  for (const dir of ['src', 'tests']) readDir(root, dir, files);
  for (const name of ['package.json', 'tsconfig.json']) files[name] = fs.readFileSync(path.join(root, name), 'utf8');
  return files;
}

function replaceOnce(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `fixture no longer contains: ${from}`);
  return source.replace(from, to);
}

/** Replace volatile values (SHAs, version, timestamp, content hash) with stable placeholders. */
function normalize(value: unknown, shas: { base?: string; head?: string }): unknown {
  const json = JSON.stringify(value);
  const text = json
    .split(shas.base ?? '\u0000').join('<BASE>')
    .split(shas.head ?? '\u0000').join('<HEAD>')
    .replace(/\b[0-9a-f]{40}\b/g, '<SHA>');
  const parsed = JSON.parse(text);
  delete parsed.technicalGraph?.repository?.generatedAt;
  if (parsed.analyzerVersion) parsed.analyzerVersion = '<VERSION>';
  if (parsed.sourceState?.contentIdentity) parsed.sourceState.contentIdentity = '<CONTENT>';
  return parsed;
}

function expectGolden(name: string, actual: unknown) {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, serialized);
    return;
  }
  assert.ok(fs.existsSync(file), `Missing golden ${file}. Run with UPDATE_GOLDENS=1 to create it.`);
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')));
}

type Scenario = {
  name: string;
  /** Fixture folder under fixtures/. Defaults to test-project. */
  fixture?: string;
  expectedOutcome: string;
  /** Returns the edited files; omitted files stay unchanged. Return undefined for no edit. */
  edit?: (files: Files) => Files;
  mode?: 'commit' | 'working-tree';
};

const scenarios: Scenario[] = [
  { name: 'charge-card-deep-chain', expectedOutcome: 'completed', edit: f => ({
    'src/billing.ts': replaceOnce(f['src/billing.ts'], 'amount <= 1', 'amount <= 5') }) },
  { name: 'format-currency-fan-in', expectedOutcome: 'completed', edit: f => ({
    'src/utils.ts': replaceOnce(f['src/utils.ts'], 'toFixed(2)', 'toFixed(3)') }) },
  { name: 'slugify-zero-impact', expectedOutcome: 'completed', edit: f => ({
    'src/utils.ts': replaceOnce(f['src/utils.ts'], '.trim()', '.trim().normalize()') }) },
  { name: 'two-edits-one-file', expectedOutcome: 'completed', edit: f => ({
    'src/utils.ts': replaceOnce(replaceOnce(f['src/utils.ts'], 'toFixed(2)', 'toFixed(3)'),
      '.trim()', '.trim().normalize()') }) },
  { name: 'comment-only-edit', expectedOutcome: 'no_supported_changes', edit: f => ({
    'src/utils.ts': replaceOnce(f['src/utils.ts'], 'export function generateId',
      '// ids are time based\nexport function generateId') }) },
  { name: 'unsupported-constructs-only', expectedOutcome: 'no_supported_changes', edit: () => ({
    'src/arrows.ts': 'export const double = (n: number) => n * 2;\nexport const triple = (n: number) => n * 3;\n' }) },
  { name: 'no-changes', expectedOutcome: 'no_changes' },
  { name: 'working-tree-mode', expectedOutcome: 'completed', mode: 'working-tree', edit: f => ({
    'src/billing.ts': replaceOnce(f['src/billing.ts'], 'amount <= 1', 'amount <= 5') }) },
  // modern-app: the "before" baseline. Arrow functions, classes and components are not
  // extracted yet, so these goldens should improve as Phases 1 to 4 land.
  { name: 'modern-app-no-changes', fixture: 'modern-app', expectedOutcome: 'no_changes' },
  { name: 'modern-app-arrow-function-edit', fixture: 'modern-app', expectedOutcome: 'no_supported_changes', edit: f => ({
    'src/utils/format.ts': replaceOnce(f['src/utils/format.ts'], 'toFixed(2)', 'toFixed(3)') }) },
  { name: 'modern-app-class-method-edit', fixture: 'modern-app', expectedOutcome: 'no_supported_changes', edit: f => ({
    'src/services/order-service.ts': replaceOnce(f['src/services/order-service.ts'], 'formatPrice(0)', 'formatPrice(1)') }) },
  { name: 'modern-app-component-edit', fixture: 'modern-app', expectedOutcome: 'no_supported_changes', edit: f => ({
    'src/components/OrderList.tsx': f['src/components/OrderList.tsx'] + '\n// touched\nconst touched = () => 1;\n' }) },
  { name: 'modern-app-named-function-edit', fixture: 'modern-app', expectedOutcome: 'completed', edit: f => ({
    'src/utils/format.ts': replaceOnce(f['src/utils/format.ts'], '.trim()', '.trim().normalize()') }) },
];

for (const scenario of scenarios) {
  test(`golden: ${scenario.name}`, () => {
    const repo = createRepo('graphentra-golden-');
    try {
      const base = readFixture(scenario.fixture ?? 'test-project');
      for (const [file, content] of Object.entries(base)) {
        fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, file), content);
      }
      repo.git(['add', '-A']);
      repo.git(['commit', '-m', 'base']);
      const baseSha = repo.git(['rev-parse', 'HEAD']);

      const edits = scenario.edit?.(base) ?? {};
      for (const [file, content] of Object.entries(edits)) fs.writeFileSync(path.join(repo.dir, file), content);

      let headSha = baseSha;
      if (scenario.mode !== 'working-tree' && Object.keys(edits).length > 0) {
        repo.git(['add', '-A']);
        repo.git(['commit', '-m', 'head']);
        headSha = repo.git(['rev-parse', 'HEAD']);
      }
      const comparison = scenario.mode === 'working-tree'
        ? { mode: 'working-tree' as const, base: 'HEAD' }
        : { mode: 'commit' as const, base: baseSha, head: headSha };

      const result = analyzeRepository({ target: repo.dir, comparison });
      assert.equal(result.outcome, scenario.expectedOutcome);
      expectGolden(scenario.name, normalize(result.evidence, { base: baseSha, head: headSha }));
    } finally {
      repo.cleanup();
    }
  });
}
