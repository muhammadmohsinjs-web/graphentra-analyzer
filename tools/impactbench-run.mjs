#!/usr/bin/env node
// Runs the analyzer on every D-0 corpus entry and records the result in impactbench/runs/.
// A gap closes only on these numbers: see impactbench/gaps/README.md.
//
// Usage: npm run bench:corpus -- <history-dir> [entry-id ...]
// <history-dir> holds one full-history clone per repo, named after it. See impactbench/corpus/README.md.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [historyDir, ...only] = process.argv.slice(2);
if (!historyDir) throw new Error('Usage: npm run bench:corpus -- <history-dir> [entry-id ...]');
const history = path.resolve(historyDir);
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'impactbench/corpus/d0-corpus.json'), 'utf8'));
const tsx = pathToFileURL(createRequire(path.join(ROOT, 'package.json')).resolve('tsx')).href;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'impactbench-run-'));

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const totals = { all: [0, 0], outside: [0, 0], consumer: [0, 0] };
const added = [];
const tally = (bucket, hit) => { totals[bucket][1] += 1; if (hit) totals[bucket][0] += 1; };

try {
  for (const entry of corpus.filter((item) => only.length === 0 || only.includes(item.id))) {
    const checkout = path.join(work, entry.repo);
    if (!fs.existsSync(checkout)) run('git', ['clone', '-q', '--shared', '--no-checkout', path.join(history, entry.repo), checkout], work);
    run('git', ['checkout', '-qf', entry.introducer.sha], checkout);
    run('git', ['clean', '-qfdx'], checkout);
    const evidencePath = path.join(work, `${entry.id}.evidence.json`);
    run(process.execPath, ['--import', tsx, 'packages/analyzer/src/cli.ts', '--target', checkout, '--base', `${entry.introducer.sha}~1`,
      '--head', entry.introducer.sha, '--engine', 'extended', '--output', evidencePath], ROOT);
    run(process.execPath, ['tools/impactbench-gaps.mjs', 'record', entry.id, evidencePath], ROOT);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const flagged = new Set(evidence.impacts.flatMap((impact) => [impact.changedEntity.id, ...impact.blastRadius.entities.map((item) => item.id),
      ...(impact.receivesChangedValue ?? []).map((target) => target.entity.id)]));
    const callersOnly = new Set(evidence.impacts.flatMap((impact) => [impact.changedEntity.id, ...impact.blastRadius.entities.map((item) => item.id)]));
    added.push(flagged.size - callersOnly.size);
    for (const truth of entry.affected.entities) {
      const hit = flagged.has(truth.id);
      tally('all', hit);
      if (truth.outsideIntroducerDiff) tally('outside', hit);
      if (truth.role === 'consumer') tally('consumer', hit);
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

added.sort((a, b) => a - b);
console.log(`Entries: ${added.length}`);
for (const [name, [hit, total]] of Object.entries(totals)) console.log(`${name.padEnd(9)} ${hit} of ${total}`);
console.log(`Added by value flow per entry: mean ${(added.reduce((sum, value) => sum + value, 0) / (added.length || 1)).toFixed(1)}, median ${added[Math.floor(added.length / 2)] ?? 0}, max ${added.at(-1) ?? 0}`);
