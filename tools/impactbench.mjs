#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'impactbench');
const WORK = path.join(ROOT, 'work');
const SHA = /^[0-9a-f]{40}$/;

function loadApps(only) {
  const apps = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps.json'), 'utf8'));
  for (const app of apps) {
    if (!SHA.test(app.commit)) throw new Error(`${app.name}: commit must be a full 40-character SHA`);
  }
  return only.length ? apps.filter((a) => only.includes(a.name)) : apps;
}

function run(cmd, cwd, inherit = true) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, npm_config_cache: path.join(WORK, '.npm-cache') },
  });
}

function head(dir) {
  return run(['git', 'rev-parse', 'HEAD'], dir, false).stdout.trim();
}

function fetchApp(app) {
  const dir = path.join(WORK, app.name);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    for (const step of [
      ['git', 'init', '-q'],
      ['git', 'remote', 'add', 'origin', app.repo],
    ]) run(step, dir);
  }
  if (head(dir) !== app.commit) {
    for (const step of [
      ['git', 'fetch', '--depth', '1', 'origin', app.commit],
      ['git', 'checkout', '-q', '--force', app.commit],
    ]) {
      if (run(step, dir).status !== 0) throw new Error(`${app.name}: ${step.join(' ')} failed`);
    }
  }
  if (head(dir) !== app.commit) throw new Error(`${app.name}: HEAD is not the pinned commit`);
  if (run(app.install, dir).status !== 0) throw new Error(`${app.name}: install failed`);
  console.log(`${app.name}: pinned at ${app.commit.slice(0, 10)}`);
}

function baselineApp(app) {
  const dir = path.join(WORK, app.name);
  if (head(dir) !== app.commit) throw new Error(`${app.name}: run bench:fetch first`);
  const started = Date.now();
  const result = run(app.test, dir, false);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  const count = (re) => Number(output.match(re)?.[1] ?? 0);
  const baseline = {
    name: app.name,
    commit: app.commit,
    exitCode: result.status,
    passed: count(/Tests\s+(?:\d+ failed \| )?(\d+) passed/) || count(/ℹ pass (\d+)/),
    failed: count(/Tests\s+(\d+) failed/) || count(/ℹ fail (\d+)/),
    seconds,
  };
  fs.writeFileSync(path.join(ROOT, 'baselines', `${app.name}.json`), JSON.stringify(baseline, null, 2) + '\n');
  console.log(`${app.name}: exit ${baseline.exitCode}, ${baseline.passed} passed, ${baseline.failed} failed, ${seconds}s`);
  if (result.status !== 0) {
    console.log(output.split('\n').slice(-25).join('\n'));
    process.exitCode = 1;
  }
}

const [command, ...names] = process.argv.slice(2);
const apps = loadApps(names);
if (command === 'fetch') apps.forEach(fetchApp);
else if (command === 'baseline') apps.forEach(baselineApp);
else {
  console.error('usage: impactbench.mjs fetch|baseline [app...]');
  process.exit(2);
}
