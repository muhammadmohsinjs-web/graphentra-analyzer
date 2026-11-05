#!/usr/bin/env node
// Replays the change on a throwaway copy of the app at the pinned commit, proves the expected behavior, then scores the analyzer.
// Exit 1 means the benchmark itself no longer holds. Analyzer misses only fail with --strict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scenarioDir, '../../..');
const expectedPath = path.join(scenarioDir, 'expected.json');
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const tsx = pathToFileURL(createRequire(path.join(repoRoot, 'package.json')).resolve('tsx')).href;
const strict = process.argv.includes('--strict');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-sku-slugify-'));
const evidencePath = `${work}-evidence.json`;
const archivePath = `${work}-app.tar`;

const run = (command, args, cwd = work) => spawnSync(command, args, { cwd, encoding: 'utf8' });
const git = (...args) => {
  const result = run('git', ['-c', 'user.name=scenario', '-c', 'user.email=scenario@example.com', '-c', 'commit.gpgsign=false', ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
};
const appTests = () => {
  const files = fs.readdirSync(path.join(work, 'tests')).filter(name => name.endsWith('.test.ts')).map(name => `tests/${name}`);
  return run(process.execPath, ['--import', tsx, '--test', ...files]);
};
const probe = () => {
  const result = run(process.execPath, ['--import', tsx, 'proof/probe.ts', expectedPath]);
  if (result.status !== 0) throw new Error(`probe: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

const same = (actual, wanted) => {
  try {
    assert.deepEqual(actual, wanted);
    return true;
  } catch {
    return false;
  }
};
const describeOutcome = ({ status, saved, total }) => (saved ? `${status}, saved as ${saved.join(' + ')}, total ${total}` : `${status}, nothing saved`);

let truthHolds = true;
const check = (label, ok) => {
  truthHolds &&= ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

try {
  // Taken from git, not the working tree, so uncommitted edits to the app can't change the result.
  const archive = run('git', ['archive', '--format=tar', '-o', archivePath, expected.baseCommit, '--', expected.app], repoRoot);
  if (archive.status !== 0) throw new Error(`git archive ${expected.baseCommit}: ${archive.stderr}`);
  const extract = run('tar', ['-xf', archivePath, `--strip-components=${expected.app.split('/').length}`]);
  if (extract.status !== 0) throw new Error(`tar: ${extract.stderr}`);
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(work, 'proof'));
  fs.copyFileSync(path.join(scenarioDir, 'probe.ts'), path.join(work, 'proof/probe.ts'));

  console.log('Expected behavior:');
  check('before the change: the app tests pass', appTests().status === 0);
  const before = probe();
  expected.behavior.forEach((scenario, i) => check(`before: ${scenario.name} -> ${describeOutcome(scenario.before)}`, same(before[i], scenario.before)));

  git('apply', path.join(scenarioDir, 'introduce-change.patch'));
  git('add', 'src');
  git('commit', '-qm', expected.change.subject);

  const after = probe();
  expected.behavior.forEach((scenario, i) => check(`after: ${scenario.name} -> ${describeOutcome(scenario.withChange)}`, same(after[i], scenario.withChange)));
  const tests = appTests();
  for (const name of expected.appTestsFailingWithChange) check(`after: app test fails: ${name}`, tests.stdout.includes(`✖ ${name}`));

  fs.rmSync(path.join(work, 'proof'), { recursive: true });
  const analysis = run(process.execPath, ['--import', tsx, 'packages/analyzer/src/cli.ts', '--target', work,
    '--base', 'HEAD~1', '--head', 'HEAD', '--engine', 'extended', '--output', evidencePath], repoRoot);
  if (analysis.status !== 0) throw new Error(`analyzer: ${analysis.stderr}`);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const flagged = new Set(evidence.impacts.flatMap(impact => [impact.changedEntity.id, ...impact.blastRadius.entities.map(entity => entity.id)]));

  const { mustFind, mustNotFlag } = expected.analyzer;
  const known = new Set(evidence.technicalGraph.entities.map(entity => entity.id));
  for (const { id } of [...mustFind, ...mustNotFlag]) check(`scored entity exists in the graph: ${id}`, known.has(id));
  const missed = mustFind.filter(entity => !flagged.has(entity.id));
  const noise = mustNotFlag.filter(entity => flagged.has(entity.id));
  console.log(`\nGraphentra score: found ${mustFind.length - missed.length} of ${mustFind.length}, wrongly flagged ${noise.length} of ${mustNotFlag.length}`);
  for (const entity of missed) console.log(`  missed (${entity.role}): ${entity.id}`);
  for (const entity of noise) console.log(`  wrongly flagged: ${entity.id}`);

  if (!truthHolds) console.log('\nThe benchmark no longer matches the app. See FAIL above.');
  process.exitCode = !truthHolds || (strict && (missed.length > 0 || noise.length > 0)) ? 1 : 0;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(evidencePath, { force: true });
  fs.rmSync(archivePath, { force: true });
}
