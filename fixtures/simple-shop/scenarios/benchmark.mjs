#!/usr/bin/env node
// Scores the analyzer's evidence.json against the truth in scenarios.json, and says how far away each miss is.
// Always builds from the committed src/, so uncommitted edits in src/ don't change the score.
// The "what if" rows are worked out from the saved graph. They don't run a real fix.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scenarioDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scenarioDir);
const repoRoot = path.resolve(appDir, '../..');
const outputDir = path.join(appDir, '.scenario-output');
const tsx = pathToFileURL(createRequire(path.join(repoRoot, 'package.json')).resolve('tsx')).href;
const scenarios = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenarios.json'), 'utf8'));

// All the shop's bugs on one commit, like the edits a person would make. Not counted in the totals.
const COMBINED = ['customer-title', 'price-table-in-dollars'];
const combine = () => {
  const parts = COMBINED.map(id => scenarios.find(scenario => scenario.id === id));
  const changed = [...new Set(parts.flatMap(part => part.changed))];
  const receives = [...new Set(parts.flatMap(part => part.receivesChangedValue))].filter(id => !changed.includes(id));
  const clean = [...new Set(parts.flatMap(part => part.doesNotReceiveChangedValue))]
    .filter(id => !receives.includes(id) && !changed.includes(id));
  return { id: 'combined', patches: parts.map(part => part.patch), changed, receivesChangedValue: receives, doesNotReceiveChangedValue: clean };
};

const analyze = (id, patches) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-shop-bench-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  try {
    execSync(`git archive HEAD:fixtures/simple-shop src package.json tsconfig.json | tar -x -C "${work}"`, { cwd: repoRoot });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'base');
    for (const patch of patches) git('apply', path.join(scenarioDir, patch));
    git('add', 'src');
    git('commit', '-qm', id);
    const evidencePath = path.join(outputDir, `${id}.evidence.json`);
    const analysis = spawnSync(process.execPath, ['--import', tsx, 'packages/analyzer/src/cli.ts', '--target', work,
      '--base', 'HEAD~1', '--head', 'HEAD', '--engine', 'extended', '--output', evidencePath], { cwd: repoRoot, encoding: 'utf8' });
    if (analysis.status !== 0) throw new Error(`analyzer: ${analysis.stderr}`);
    return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

/** Steps from each start to every entity it can reach. */
const walk = (starts, neighbours, maxSteps = Infinity) => {
  const steps = new Map(starts.map(id => [id, 0]));
  const queue = [...starts];
  while (queue.length > 0) {
    const id = queue.shift();
    const step = steps.get(id);
    if (step >= maxSteps) continue;
    for (const next of neighbours.get(id) ?? []) {
      if (!steps.has(next)) {
        steps.set(next, step + 1);
        queue.push(next);
      }
    }
  }
  return steps;
};

const score = (scenario) => {
  const evidence = analyze(scenario.id, scenario.patches ?? [scenario.patch]);
  const forward = new Map();
  const backward = new Map();
  for (const { from, to } of evidence.technicalGraph.relations) {
    forward.set(from, [...(forward.get(from) ?? []), to]);
    backward.set(to, [...(backward.get(to) ?? []), from]);
  }
  const changed = evidence.impacts.map(impact => impact.changedEntity.id);
  const callersOnly = new Set([...changed, ...evidence.impacts.flatMap(impact => impact.blastRadius.entities.map(entity => entity.id))]);
  const today = new Set([...callersOnly, ...evidence.impacts.flatMap(impact => (impact.receivesChangedValue ?? []).map(target => target.entity.id))]);
  const callers = walk(changed, backward);

  const count = (flagged) => ({
    found: scenario.receivesChangedValue.filter(id => flagged.has(id)).length,
    wrong: scenario.doesNotReceiveChangedValue.filter(id => flagged.has(id)).length,
  });
  const withForward = (starts, maxSteps) => new Set([...callersOnly, ...walk(starts, forward, maxSteps).keys()]);
  const directCallers = [...callers].filter(([, steps]) => steps === 1).map(([id]) => id);

  const describeMiss = (id) => {
    const down = walk(changed, forward).get(id);
    if (down !== undefined) return { id, route: `forward ${down}`, steps: down };
    let best = null;
    for (const [caller, up] of callers) {
      const steps = walk([caller], forward).get(id);
      if (steps !== undefined && (best === null || up + steps < best.up + best.steps)) best = { up, steps };
    }
    return best
      ? { id, route: `up ${best.up}, forward ${best.steps}`, steps: best.up + best.steps }
      : { id, route: 'no path in the graph', steps: null };
  };

  return {
    id: scenario.id,
    expected: scenario.receivesChangedValue.length,
    clean: scenario.doesNotReceiveChangedValue.length,
    changed,
    flagged: [...today].filter(id => !changed.includes(id)),
    misses: scenario.receivesChangedValue.filter(id => !today.has(id)).map(describeMiss),
    received: [...today].filter(id => !callersOnly.has(id)),
    strategies: {
      'Today (callers plus value flow)': count(today),
      'Before: toward callers only': count(callersOnly),
      'What if: forward 1 step': count(withForward(changed, 1)),
      'What if: forward 2 steps': count(withForward(changed, 2)),
      'What if: forward, any distance': count(withForward(changed)),
      'What if: forward from direct callers too': count(withForward([...changed, ...directCallers])),
    },
  };
};

const pct = (part, whole) => (whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`);
const name = id => id.replace(/^src\/[^#]*#/, '');

fs.mkdirSync(outputDir, { recursive: true });
const results = scenarios.map(score);
const combined = score(combine());

console.log('Scenario                 Found    Wrongly flagged   Missed');
for (const result of [...results, combined]) {
  const today = result.strategies['Today (callers plus value flow)'];
  console.log(`${result.id.padEnd(24)} ${`${today.found} of ${result.expected}`.padEnd(8)} ${`${today.wrong} of ${result.clean}`.padEnd(17)} ${result.misses.map(miss => name(miss.id)).join(', ') || 'none'}`);
}
console.log('(combined is customer-title and price-table-in-dollars on one commit. It is not in the totals.)');

console.log('\nHow far each miss is from the changed code, in the graph');
for (const result of results) {
  for (const miss of result.misses) console.log(`  ${result.id.padEnd(24)} ${name(miss.id).padEnd(18)} ${miss.route}`);
}

const expected = results.reduce((sum, result) => sum + result.expected, 0);
const clean = results.reduce((sum, result) => sum + result.clean, 0);
const totals = {};
console.log(`\nAll ${results.length} scenarios                        Found          Wrongly flagged`);
for (const strategy of Object.keys(results[0].strategies)) {
  const found = results.reduce((sum, result) => sum + result.strategies[strategy].found, 0);
  const wrong = results.reduce((sum, result) => sum + result.strategies[strategy].wrong, 0);
  totals[strategy] = { found, wrong, expected, clean };
  console.log(`${strategy.padEnd(41)} ${`${found} of ${expected} (${pct(found, expected)})`.padEnd(14)} ${wrong} of ${clean} (${pct(wrong, clean)})`);
}

const reportPath = path.join(outputDir, 'benchmark.json');
fs.writeFileSync(reportPath, `${JSON.stringify({ analyzerVersion: JSON.parse(fs.readFileSync(path.join(outputDir, `${scenarios[0].id}.evidence.json`), 'utf8')).analyzerVersion, totals, scenarios: results, combined }, null, 2)}\n`);
console.log(`\nSaved ${path.relative(repoRoot, reportPath)} and one evidence.json per scenario next to it.`);
