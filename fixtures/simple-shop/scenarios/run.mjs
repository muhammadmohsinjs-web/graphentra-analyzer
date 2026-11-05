#!/usr/bin/env node
// Applies each one-line change to a throwaway copy, proves what the customer sees, then scores Graphentra.
// Exit 1 means the app no longer behaves as described. Graphentra misses only fail with --strict.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scenarioDir);
const repoRoot = path.resolve(appDir, '../..');
const outputDir = path.join(appDir, '.scenario-output');
const scenarios = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenarios.json'), 'utf8'));
const tsx = pathToFileURL(createRequire(path.join(repoRoot, 'package.json')).resolve('tsx')).href;
const strict = process.argv.includes('--strict');

const matches = (actual, expected) => {
  try { assert.deepEqual(actual, expected); return true; } catch { return false; }
};

let appBehaves = true;
let allFound = true;
fs.mkdirSync(outputDir, { recursive: true });

for (const scenario of scenarios) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-simple-shop-'));
  const run = (command, args, cwd = work) => spawnSync(command, args, { cwd, encoding: 'utf8' });
  const git = (...args) => {
    const result = run('git', ['-c', 'user.name=scenario', '-c', 'user.email=scenario@example.com', '-c', 'commit.gpgsign=false', ...args]);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  const order = () => {
    const result = run(process.execPath, ['--import', tsx, 'proof/order.ts']);
    if (result.status !== 0) throw new Error(`order: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const check = (label, ok) => {
    appBehaves &&= ok;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };

  try {
    console.log(`\n${scenario.id}: ${scenario.title}`);
    for (const name of ['src', 'package.json', 'tsconfig.json']) {
      fs.cpSync(path.join(appDir, name), path.join(work, name), { recursive: true });
    }
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'base');
    fs.mkdirSync(path.join(work, 'proof'));
    fs.copyFileSync(path.join(scenarioDir, 'order.ts'), path.join(work, 'proof/order.ts'));

    check(`before: ${JSON.stringify(scenario.correct)}`, matches(order(), scenario.correct));
    git('apply', path.join(scenarioDir, scenario.patch));
    git('add', 'src');
    git('commit', '-qm', scenario.subject);
    check(`after:  ${JSON.stringify(scenario.withChange)}`, matches(order(), scenario.withChange));

    fs.rmSync(path.join(work, 'proof'), { recursive: true });
    const evidencePath = path.join(outputDir, `${scenario.id}.evidence.json`);
    const analysis = run(process.execPath, ['--import', tsx, 'packages/analyzer/src/cli.ts', '--target', work,
      '--base', 'HEAD~1', '--head', 'HEAD', '--engine', 'extended', '--output', evidencePath], repoRoot);
    if (analysis.status !== 0) throw new Error(`analyzer: ${analysis.stderr}`);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const changed = evidence.impacts.map(impact => impact.changedEntity.id);
    const blast = [...new Set(evidence.impacts.flatMap(impact => impact.blastRadius.entities.map(entity => entity.id)))];
    const received = [...new Set(evidence.impacts.flatMap(impact => (impact.receivesChangedValue ?? []).map(target => target.entity.id)))];
    const flagged = new Set([...changed, ...blast, ...received]);
    const missed = scenario.receivesChangedValue.filter(id => !flagged.has(id));
    const noise = scenario.doesNotReceiveChangedValue.filter(id => flagged.has(id));
    const linked = (from, to) => evidence.technicalGraph.relations.some(relation => relation.from === from && relation.to === to);

    check(`Graphentra sees the changed code: ${scenario.changed.join(', ')}`, scenario.changed.every(id => flagged.has(id)));
    console.log(`  changed: ${changed.join(', ')}`);
    console.log(`  blast radius: ${blast.join(', ') || 'none'}`);
    console.log(`  receives the changed value: ${received.join(', ') || 'none'}`);
    console.log(`  score: found ${scenario.receivesChangedValue.length - missed.length} of ${scenario.receivesChangedValue.length}, wrongly flagged ${noise.length} of ${scenario.doesNotReceiveChangedValue.length}`);
    for (const id of missed) console.log(`  missed: ${id}`);
    for (const id of noise) console.log(`  wrongly flagged: ${id}`);
    console.log(`  links out of placeOrder in the graph: ${['src/stock.ts#stockOf', 'src/payment.ts#chargeCard', 'src/receipt.ts#buildReceipt'].filter(id => linked('src/shop.ts#placeOrder', id)).length} of 3`);
    if (missed.length > 0 || noise.length > 0) allFound = false;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (!appBehaves) console.log('\nThe app no longer behaves as described. See FAIL above.');
process.exitCode = !appBehaves || (strict && !allFound) ? 1 : 0;
