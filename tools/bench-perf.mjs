#!/usr/bin/env node
// Analyzer performance bench (P4-4).
// Usage: node tools/bench-perf.mjs [--runs 5] [--sizes 1000,5000] [--loc 40] [--profile] [--skip-impactbench] [--keep]
// --profile: also run once with `node --cpu-prof` on the largest synthetic repo and print top self-time costs.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'packages/analyzer/src/cli.ts');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const flag = (name) => args.includes(`--${name}`);
const RUNS = Number(opt('runs', 5));
const SIZES = opt('sizes', '1000,5000').split(',').map(Number);
const LOC = Number(opt('loc', 40));
const TIMEOUT = 10 * 60 * 1000;

// Peak RSS comes from process.resourceUsage().maxRSS (KB) in the child, reported by a preload hook,
// so the bench needs no /usr/bin/time and works on macOS and Linux.
const PRELOAD = path.join(os.tmpdir(), `graphentra-bench-rss-${process.pid}.cjs`);
fs.writeFileSync(PRELOAD, "process.on('exit', () => { process.stderr.write('BENCH_MAXRSS_KB=' + process.resourceUsage().maxRSS + '\\n'); });\n");
process.on('exit', () => fs.rmSync(PRELOAD, { force: true }));

function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function fileBody(i, total, loc) {
  // Fan-in on ~50 hub modules keeps import/type chains shallow (a long chain overflows the TS checker stack).
  const hubs = Math.min(50, total);
  const dep = i < hubs ? (i + 1) % hubs : (i * 7 + 1) % hubs, dep2 = i < hubs ? (i + 2) % hubs : (i * 13 + 5) % hubs;
  const lines = [
    `import { fn${dep}, type Rec${dep} } from './m${dep}';`,
    `import { fn${dep2} } from './m${dep2}';`,
    '',
    `export interface Rec${i} { id: number; name: string; tags: string[]; parent?: Rec${dep}; }`,
    '',
    `export class Svc${i} {`,
    `  private readonly items: Rec${i}[] = [];`,
    `  add(item: Rec${i}): number { this.items.push(item); return this.items.length; }`,
    `  find(id: number): Rec${i} | undefined { return this.items.find(x => x.id === id); }`,
    `  total(): number { return this.items.reduce((s, x) => s + x.tags.length, 0); }`,
    `}`,
    '',
  ];
  const n = Math.max(1, Math.floor((loc - lines.length - 5) / 4));
  for (let k = 0; k < n; k++) {
    lines.push(`export function helper${i}_${k}(v: number): number {`,
      `  const base = fn${dep}(v) + fn${dep2}(v + ${k});`,
      `  return base > ${k} ? base - ${k} : base + ${k};`, `}`);
  }
  lines.push(`export function fn${i}(v: number): number {`, `  return v + ${i};`, `}`);
  while (lines.length < loc) lines.push(`// padding ${lines.length}`);
  return lines.join('\n') + '\n';
}

function generateRepo(files, loc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `graphentra-bench-${files}-`));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"synthetic","version":"1.0.0","private":true}\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, skipLibCheck: true, noEmit: true }, include: ['src'] }));
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, 'src', `m${i}.ts`), fileBody(i, files, loc));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'bench@example.com'); git(dir, 'config', 'user.name', 'bench');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  fs.appendFileSync(path.join(dir, 'src', 'm0.ts'), 'export function changed(v: number): number {\n  return fn0(v) * 2;\n}\n');
  return dir;
}

function countLoc(dir) {
  let files = 0, loc = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', '.graphentra', 'work', 'dist'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts')) { files++; loc += fs.readFileSync(p, 'utf8').split('\n').length; }
    }
  };
  walk(dir);
  return { files, loc };
}

function parseRss(stderr) {
  const m = stderr.match(/BENCH_MAXRSS_KB=(\d+)/); return m ? Number(m[1]) / 1024 : NaN;
}

function analyze(target, extra = [], nodeFlags = []) {
  const out = path.join(os.tmpdir(), `graphentra-bench-evidence-${process.pid}.json`);
  const cmd = [process.execPath, '--require', PRELOAD, ...nodeFlags, '--import', 'tsx', CLI, '--target', target, '--working-tree', '--output', out, ...extra];
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 1 << 28 });
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  fs.rmSync(out, { force: true });
  if (r.status !== 0) throw new Error(`analyzer failed (${r.status}) on ${target}:\n${(r.stdout + r.stderr).slice(-1500)}`);
  return { seconds, rssMb: parseRss(r.stderr) };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
function measure(label, target) {
  const { files, loc } = countLoc(target);
  const runs = [];
  for (let i = 0; i < RUNS; i++) { runs.push(analyze(target)); process.stderr.write(`  ${label} run ${i + 1}/${RUNS}: ${runs[i].seconds.toFixed(1)}s\n`); }
  const t = runs.map(r => r.seconds).sort((a, b) => a - b);
  return { label, files, loc, min: t[0], median: pct(t, 0.5), p95: pct(t, 0.95), rss: Math.max(...runs.map(r => r.rssMb)) };
}

function profile(target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-cpuprof-'));
  analyze(target, [], ['--cpu-prof', '--cpu-prof-dir', dir]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.cpuprofile'));
  const prof = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const byId = new Map(prof.nodes.map(n => [n.id, n]));
  const self = new Map();
  const dt = prof.timeDeltas;
  prof.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const fn = new Map(), mod = new Map();
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame, url = cf.url || '(native)';
    const m = url.includes('node_modules/typescript/') ? `typescript/${path.basename(url)}` : url.startsWith('node:') ? 'node:internal' : url.includes(ROOT) ? path.relative(ROOT, url.replace('file://', '')) : url;
    const f = `${cf.functionName || '(anonymous)'} [${m}]`;
    fn.set(f, (fn.get(f) ?? 0) + us); mod.set(m, (mod.get(m) ?? 0) + us);
  }
  const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `${(us / 1e6).toFixed(2)}s ${(100 * us / total).toFixed(1)}%  ${k}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nCPU profile (self time, total ${(total / 1e6).toFixed(1)}s) on ${target}`);
  console.log('Top modules:\n  ' + top(mod, 8).join('\n  '));
  console.log('Top functions:\n  ' + top(fn, 15).join('\n  '));
}

const results = [], temps = [];
console.log(`Machine: ${os.cpus()[0].model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB, ${process.platform} ${os.release()}, Node ${process.version}`);
results.push(measure('fixtures/modern-app', path.join(ROOT, 'fixtures/modern-app')));
let largest;
for (const n of SIZES) { const dir = generateRepo(n, LOC); temps.push(dir); largest = dir; results.push(measure(`synthetic-${n}`, dir)); }
if (!flag('skip-impactbench')) {
  const work = path.join(ROOT, 'impactbench/work');
  if (fs.existsSync(work)) for (const name of fs.readdirSync(work)) {
    const dir = path.join(work, name);
    if (fs.existsSync(path.join(dir, '.git'))) try { results.push(measure(`impactbench/${name}`, dir)); } catch (e) { console.log(`skip ${name}: ${String(e.message).split('\n')[0]}`); }
  } else console.log('impactbench/work absent; skipping (run the impactbench fetch first)');
}
console.log(`\n| target | files | LOC | min s | median s | p95 s | peak RSS MB |\n|---|---|---|---|---|---|---|`);
for (const r of results) console.log(`| ${r.label} | ${r.files} | ${r.loc} | ${r.min.toFixed(1)} | ${r.median.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.rss.toFixed(0)} |`);
if (flag('profile') && largest) profile(largest);
if (!flag('keep')) for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
