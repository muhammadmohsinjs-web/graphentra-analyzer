#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeRepository, computeAttribution, isAnalyzableFile, type EngineProfile } from '@graphentra/analyzer';

interface Row {
  commit: string;
  outcome?: string;
  total?: number;
  code?: number;
  module?: number;
  unattributed?: number;
  ratio?: number;
  error?: string;
}

function parseArgs(argv: string[]) {
  const args = { repoDir: '', commits: 30, engine: 'extended' as EngineProfile, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commits') args.commits = Number(argv[++i]);
    else if (arg === '--engine') args.engine = argv[++i] as EngineProfile;
    else if (arg === '--json') args.json = true;
    else if (!args.repoDir) args.repoDir = path.resolve(arg);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.repoDir) throw new Error('Usage: tsx tools/measure-attribution.ts <repoDir> [--commits N] [--engine extended|legacy] [--json]');
  if (!Number.isInteger(args.commits) || args.commits < 1) throw new Error('--commits must be a positive integer');
  if (args.engine !== 'extended' && args.engine !== 'legacy') throw new Error('--engine must be extended or legacy');
  return args;
}

const git = (dir: string, gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();

/** The analyzer requires the checkout to equal the head revision, so each commit is analyzed in a throwaway detached worktree. */
function measure(repoDir: string, commit: string, engine: EngineProfile): Row {
  const short = commit.slice(0, 7);
  let tmp: string | undefined;
  let worktree: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-attr-'));
    worktree = path.join(tmp, 'wt');
    git(repoDir, ['worktree', 'add', '--detach', worktree, commit]);
    const result = analyzeRepository({ target: worktree, comparison: { mode: 'commit', base: `${commit}^`, head: commit }, engine });
    const attribution = result.attribution ?? computeAttribution(
      result.changedFiles.filter(change => isAnalyzableFile(change.file, engine)), result.changedEntities);
    return { commit: short, outcome: result.outcome, ...attribution };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { commit: short, error: typeof code === 'string' ? code : error instanceof Error ? error.constructor.name : 'UnknownError' };
  } finally {
    try { if (worktree) git(repoDir, ['worktree', 'remove', '--force', worktree]); } catch { /* best effort */ }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = git(args.repoDir, ['rev-list', '--first-parent', '--parents', '-n', String(args.commits), 'HEAD']).split('\n').filter(Boolean);
  const rows: Row[] = [];
  for (const line of lines) {
    const [commit, ...parents] = line.split(' ');
    if (parents.length !== 1) continue; // skip root and merge commits
    rows.push(measure(args.repoDir, commit, args.engine));
  }
  const ok = rows.filter(row => row.error === undefined);
  const sum = (key: 'total' | 'code' | 'module' | 'unattributed') => ok.reduce((acc, row) => acc + (row[key] ?? 0), 0);
  const aggregate = {
    total: sum('total'), code: sum('code'), module: sum('module'), unattributed: sum('unattributed'),
    ratio: 0, commits: rows.length, errors: rows.length - ok.length,
  };
  aggregate.ratio = aggregate.total === 0 ? 1 : Math.round((aggregate.code / aggregate.total) * 10000) / 10000;
  if (args.json) {
    console.log(JSON.stringify({ engine: args.engine, rows, aggregate }, null, 2));
    return;
  }
  console.log(['commit', 'outcome', 'total', 'code', 'module', 'unattributed', 'ratio'].join('\t'));
  for (const row of rows) {
    console.log(row.error !== undefined
      ? [row.commit, `error:${row.error}`, '-', '-', '-', '-', '-'].join('\t')
      : [row.commit, row.outcome, row.total, row.code, row.module, row.unattributed, (row.ratio ?? 1).toFixed(4)].join('\t'));
  }
  console.log(`aggregate: total=${aggregate.total} code=${aggregate.code} module=${aggregate.module} unattributed=${aggregate.unattributed} ` +
    `ratio=${aggregate.ratio.toFixed(4)} commits=${aggregate.commits} errors=${aggregate.errors}`);
}

main();
