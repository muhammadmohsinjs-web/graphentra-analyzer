#!/usr/bin/env node
// D-0: mine candidate (bug-introducing commit, fix commit) pairs with SZZ.
// For each fix commit, blame the lines it removed or changed in its parent; the commit that
// wrote most of those lines is the candidate introducer. Output is a candidate list for human
// curation, not ground truth.
//
// Usage: node tools/impactbench-corpus.mjs <history-dir> [repo ...] [--out file]
//        node tools/impactbench-corpus.mjs merge <parts-dir> <out-dir>
// <history-dir> holds full-history clones, one folder per repo. Blobless clones work but blame
// then fetches blobs one by one; `git fetch --refetch` without the filter first is much faster.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIX = /\b(fix(es|ed)?|regression|hotfix|bug)\b/i;
const SKIP = /\b(deps?|dependency|dependencies|typo|docs?|readme|ci|lint|prettier|format(ting)?|types?only|changelog|release|lockfile|renovate|test(s)?:)\b|^(chore|docs|ci|build|test|style)(\(|:)/i;
const NOISE = /\b(format|prettier|lint|rename|move|refactor|migrate to|monorepo|initial|import)\b/i;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_SOURCE_FILES = 3;
const MAX_CHANGED_LINES = 80;
const MAX_GAP_DAYS = 540;

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

function isSource(file) {
  return SOURCE.test(file) && !TEST.test(file) && !file.endsWith('.d.ts') && !/(^|\/)(dist|scripts|examples?|playground|bench)\//.test(file);
}

function changedFiles(dir, sha) {
  return git(dir, ['show', '--no-renames', '--numstat', '--format=', sha])
    .trim().split('\n').filter(Boolean)
    .map((l) => { const [a, d, file] = l.split('\t'); return { file, added: +a || 0, deleted: +d || 0 }; });
}

/** Line ranges in the parent that the fix removed or replaced. */
function parentHunks(dir, sha, file) {
  const out = git(dir, ['diff', '-U0', '--no-renames', `${sha}^`, sha, '--', file]);
  const ranges = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = +m[1];
    const count = m[2] === undefined ? 1 : +m[2];
    if (count > 0) ranges.push([start, start + count - 1]);
    // Pure insertion: blame the line above it, the code the fix had to amend.
    else if (start > 0) ranges.push([start, start]);
  }
  return ranges;
}

function blame(dir, sha, file, [from, to]) {
  const out = git(dir, ['blame', '--line-porcelain', '-w', '-L', `${from},${to}`, `${sha}^`, '--', file]);
  return [...out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)].map((m) => m[1]);
}

function meta(dir, sha) {
  const [subject, date, parents] = git(dir, ['show', '-s', '--format=%s%x00%cI%x00%P', sha]).split('\0');
  return { subject: subject?.trim() ?? '', date: date?.trim() ?? '', parents: (parents ?? '').trim().split(' ').filter(Boolean) };
}

function mineRepo(dir, name) {
  const log = git(dir, ['log', '--no-merges', '--format=%H%x00%s', 'HEAD']).trim().split('\n');
  const candidates = [];
  for (const line of log) {
    const [fix, subject] = line.split('\0');
    if (!FIX.test(subject) || SKIP.test(subject)) continue;
    const files = changedFiles(dir, fix);
    const src = files.filter((f) => isSource(f.file));
    const changed = src.reduce((n, f) => n + f.added + f.deleted, 0);
    if (src.length === 0 || src.length > MAX_SOURCE_FILES || changed > MAX_CHANGED_LINES) continue;

    const votes = new Map();
    for (const { file } of src) {
      for (const range of parentHunks(dir, fix, file)) {
        for (const sha of blame(dir, fix, file, range)) votes.set(sha, (votes.get(sha) ?? 0) + 1);
      }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length === 0) continue;
    const blamedLines = ranked.reduce((n, [, v]) => n + v, 0);
    const [introducer, introducerLines] = ranked[0];
    const im = meta(dir, introducer);
    const fm = meta(dir, fix);
    if (im.parents.length !== 1 || NOISE.test(im.subject)) continue;
    const gapDays = Math.round((Date.parse(fm.date) - Date.parse(im.date)) / 86_400_000);
    if (gapDays < 0 || gapDays > MAX_GAP_DAYS) continue;

    candidates.push({
      repo: name,
      fix: { sha: fix, subject, date: fm.date, sourceFiles: src.map((f) => f.file), testFiles: files.filter((f) => TEST.test(f.file)).map((f) => f.file), changedLines: changed },
      introducer: { sha: introducer, subject: im.subject, date: im.date, sourceFiles: changedFiles(dir, introducer).filter((f) => isSource(f.file)).map((f) => f.file) },
      szz: { blamedLines, introducerLines, share: Math.round((introducerLines / blamedLines) * 100) / 100, gapDays },
      issueRefs: [...new Set([...`${subject} ${im.subject}`.matchAll(/#(\d+)/g)].map((m) => +m[1]))],
    });
  }
  return candidates;
}

const CHANGE_CLASSES = new Set(['persisted-key', 'timing-limit-constant', 'protocol-enum', 'client-server-pair', 'return-shape', 'same-signature-behavior', 'default-option', 'plain-logic']);
const ROLES = new Set(['fault', 'caller', 'consumer']);
const SHA40 = /^[0-9a-f]{40}$/;

/** Problems that make a kept entry unusable as ground truth. */
function validate(e) {
  const p = [];
  if (!SHA40.test(e.introducer?.sha ?? '')) p.push('introducer.sha');
  if (!SHA40.test(e.fix?.sha ?? '')) p.push('fix.sha');
  if (!CHANGE_CLASSES.has(e.changeClass)) p.push(`changeClass ${e.changeClass}`);
  if (!e.symptom) p.push('symptom');
  if (!['high', 'medium', 'low'].includes(e.confidence)) p.push('confidence');
  const ents = e.affected?.entities ?? [];
  if (ents.length === 0) p.push('affected.entities empty');
  for (const x of ents) {
    if (typeof x.id !== 'string' || x.id.lastIndexOf('#') < 1) p.push(`entity id ${x.id}`);
    if (!ROLES.has(x.role)) p.push(`role ${x.role}`);
    if (typeof x.outsideIntroducerDiff !== 'boolean') p.push(`outsideIntroducerDiff ${x.id}`);
  }
  if (!(e.affected?.areas?.length > 0)) p.push('affected.areas empty');
  return p;
}

// merge <parts-dir> <out-dir>: kept entries → d0-corpus.json with stable ids; the rest → d0-rejected.json.
function merge(partsDir, outDir) {
  const all = fs.readdirSync(partsDir).filter((f) => f.endsWith('.json')).sort()
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(partsDir, f), 'utf8')));
  const seen = new Set();
  const kept = [];
  const rejected = [];
  for (const e of all) {
    const key = `${e.repo}:${e.introducer?.sha}:${e.fix?.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const problems = e.verdict === 'keep' ? validate(e) : [];
    if (e.verdict === 'keep' && problems.length === 0) kept.push(e);
    else rejected.push({ repo: e.repo, introducer: e.introducer?.sha, fix: e.fix?.sha, fixSubject: e.fix?.subject, verdict: e.verdict, reason: e.rejectReason ?? (problems.length ? `invalid: ${problems.join(', ')}` : null) });
  }
  kept.sort((a, b) => a.repo.localeCompare(b.repo) || a.fix.date.localeCompare(b.fix.date) || a.fix.sha.localeCompare(b.fix.sha));
  const counters = new Map();
  const corpus = kept.map(({ verdict, rejectReason, id, ...rest }) => {
    const n = (counters.get(rest.repo) ?? 0) + 1;
    counters.set(rest.repo, n);
    return { id: `${rest.repo}-${String(n).padStart(2, '0')}`, ...rest };
  });
  fs.writeFileSync(path.join(outDir, 'd0-corpus.json'), JSON.stringify(corpus, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'd0-rejected.json'), JSON.stringify(rejected, null, 2) + '\n');
  const byClass = {};
  for (const e of corpus) byClass[e.changeClass] = (byClass[e.changeClass] ?? 0) + 1;
  const outside = corpus.filter((e) => e.affected.entities.some((x) => x.outsideIntroducerDiff)).length;
  console.error(`kept ${corpus.length}, rejected ${rejected.length}, with entities outside the introducer diff ${outside}`);
  console.error(`by repo ${JSON.stringify(Object.fromEntries(counters))}`);
  console.error(`by class ${JSON.stringify(byClass)}`);
}

// verify <corpus.json> <history-dir>: every truth entity must exist in the extended engine's
// entity list for its file at the introducer revision (needs `npm run build` of the analyzer).
async function verify(corpusFile, historyDir) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const { collectEntities } = require('../packages/analyzer/dist/entity-collector.js');
  const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  const cache = new Map();
  let checked = 0;
  const missing = [];
  const gaps = [];
  for (const e of corpus) {
    for (const x of e.affected.entities) {
      checked++;
      const file = x.id.slice(0, x.id.lastIndexOf('#'));
      const key = `${e.repo}:${e.introducer.sha}:${file}`;
      if (!cache.has(key)) {
        const text = git(path.join(historyDir, e.repo), ['show', `${e.introducer.sha}:${file}`]);
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        cache.set(key, text ? new Set(collectEntities(sf, { relativeFile: file, engine: 'extended' }).map((c) => c.entity.id)) : null);
      }
      const ids = cache.get(key);
      if (ids === null) missing.push(`${e.id} ${x.id} (file not at introducer)`);
      else if (x.collectorGap === true) {
        // A real named symbol the collector does not make an entity (e.g. `x = wrapper(() => ...)`).
        if (ids.has(x.id)) missing.push(`${e.id} ${x.id} (marked collectorGap but the collector has it)`);
        else gaps.push(`${e.id} ${x.id}`);
      } else if (!ids.has(x.id) && !x.id.endsWith('#<module>')) {
        const name = x.id.slice(x.id.lastIndexOf('#') + 1).split(/[.>]/).pop();
        const near = [...ids].filter((id) => id.endsWith(name) || id.includes(`>${name}`) || id.includes(`.${name}`));
        missing.push(`${e.id} ${x.id}${near.length ? ` (did you mean ${near.slice(0, 3).join(', ')})` : ''}`);
      }
    }
  }
  for (const m of missing) console.log(`MISSING ${m}`);
  for (const g of gaps) console.log(`GAP ${g}`);
  console.error(`checked ${checked} entities, ${missing.length} missing, ${gaps.length} collector gaps`);
  process.exit(missing.length ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === 'merge') {
  merge(args[1], args[2]);
  process.exit(0);
}
if (args[0] === 'verify') {
  await verify(args[1], args[2]);
}
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [historyDir, ...only] = args;
if (!historyDir) {
  console.error('usage: node tools/impactbench-corpus.mjs <history-dir> [repo ...] [--out file]');
  process.exit(2);
}
const repos = only.length ? only : fs.readdirSync(historyDir).filter((d) => fs.existsSync(path.join(historyDir, d, '.git'))).sort();
const all = [];
for (const name of repos) {
  const found = mineRepo(path.join(historyDir, name), name);
  console.error(`${name}: ${found.length} candidates`);
  all.push(...found);
}
const json = JSON.stringify(all, null, 2) + '\n';
if (out) fs.writeFileSync(out, json);
else process.stdout.write(json);
