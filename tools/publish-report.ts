#!/usr/bin/env node
// Publishes the analysis in <target>/.graphentra/ to the report server, together with business-facing
// change info (repository, branch, who changed it, pull request). Run it after the analyzer.
//
//   npm run publish:report -- --target ./fixtures/test-project [--server http://localhost:3000]
//     [--repo org/repo] [--branch feature-x] [--base-branch main] [--pr 42 --pr-title "..." --pr-url https://...]
//
// In GitHub Actions the repository, branches and pull request are read from the GITHUB_* environment.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq !== -1) { values.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Option ${arg} requires a value.`);
    values.set(arg.slice(2), value);
  }
  return values;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return out || undefined;
  } catch { return undefined; }
}

/** "https://github.com/org/repo.git" or "git@github.com:org/repo.git" -> { host, name: "org/repo" } */
function parseRemote(remote: string | undefined): { host: string; name: string } | undefined {
  const match = remote?.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i);
  return match ? { host: match[1], name: match[2] } : undefined;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function githubPullRequest(): Record<string, unknown> | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return undefined;
  const pr = readJson(eventPath).pull_request;
  if (!pr) return undefined;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ? { login: pr.user.login } : undefined,
    description: typeof pr.body === 'string' ? pr.body.slice(0, 10000) : undefined,
    labels: Array.isArray(pr.labels) ? pr.labels.map((label: { name?: string }) => label.name).filter(Boolean) : undefined,
  };
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined && item !== '');
  return entries.length ? Object.fromEntries(entries) as T : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = path.resolve(args.get('target') ?? '.');
  const directory = path.join(target, '.graphentra');
  const server = (args.get('server') ?? process.env.GRAPHENTRA_REPORT_SERVER ?? 'http://localhost:3000').replace(/\/+$/, '');

  const evidencePath = path.join(directory, 'evidence.json');
  const contextPath = path.join(directory, 'application-context.json');
  const mapPath = path.join(directory, 'application-map.json');
  if (!fs.existsSync(evidencePath)) throw new Error(`No evidence at ${evidencePath}. Run the analyzer first.`);
  if (!fs.existsSync(contextPath)) throw new Error(`No application context at ${contextPath}. Generate it once with: npm run report -- --target ${args.get('target') ?? '.'} --working-tree --generate-context`);

  const evidence = readJson(evidencePath);
  if (evidence.outcome !== 'completed') {
    console.log(`Nothing to publish: analysis outcome is "${evidence.outcome}".`);
    return;
  }

  // Git / pull-request info. Explicit flags win, then CI environment, then the local checkout.
  const remote = parseRemote(git(target, ['remote', 'get-url', 'origin']));
  const repository = args.get('repo') ?? process.env.GITHUB_REPOSITORY ?? remote?.name;
  const currentBranch = git(target, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = args.get('branch') ?? (process.env.GITHUB_HEAD_REF || undefined) ?? (currentBranch !== 'HEAD' ? currentBranch : undefined);
  const baseBranch = args.get('base-branch') ?? (process.env.GITHUB_BASE_REF || undefined);

  let commit: Record<string, unknown> | undefined;
  let author: Record<string, unknown> | undefined;
  if (evidence.comparison?.mode === 'commit' && evidence.comparison.resolvedHeadSha) {
    const sha = String(evidence.comparison.resolvedHeadSha);
    const log = git(target, ['log', '-1', '--format=%an%x00%ae%x00%cI%x00%B', sha])?.split('\0');
    const commitUrl = remote?.host === 'github.com' && repository ? `https://github.com/${repository}/commit/${sha}` : undefined;
    commit = compact({ sha, message: log?.[3]?.trim(), committedAt: log?.[2], url: commitUrl });
    author = compact({ name: log?.[0], email: log?.[1] });
  } else {
    // Working-tree analysis: the change is not committed yet, so the author is whoever is running this.
    commit = { message: 'Uncommitted changes' };
    author = compact({ name: git(target, ['config', 'user.name']), email: git(target, ['config', 'user.email']) });
  }

  const prNumber = args.get('pr');
  const pullRequest = compact({
    ...githubPullRequest(),
    ...(prNumber ? { number: Number(prNumber) } : {}),
    ...(args.get('pr-title') ? { title: args.get('pr-title') } : {}),
    ...(args.get('pr-url') ? { url: args.get('pr-url') } : {}),
  });

  const change = compact({ repository, branch, baseBranch, commit, author, pullRequest });
  const body = {
    evidence,
    applicationContext: readJson(contextPath),
    applicationMap: fs.existsSync(mapPath) ? readJson(mapPath) : undefined,
    change,
  };

  console.log(`Publishing QA report for ${repository ?? 'unknown repository'}${branch ? ` (${branch})` : ''} to ${server}/reports ...`);
  const response = await fetch(`${server}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as { id?: number; error?: string; issues?: string[]; qaReport?: { summary?: string } };
  if (!response.ok) {
    throw new Error(`Report server replied ${response.status}: ${result.error ?? 'unknown error'}${result.issues ? `\n  ${result.issues.join('\n  ')}` : ''}`);
  }
  console.log(`QA report saved: id ${result.id}`);
  if (result.qaReport?.summary) console.log(`Summary: ${result.qaReport.summary}`);
  console.log(`Read it: ${server}/reports/${result.id}/md`);
}

main().catch(error => {
  console.error(`Publishing failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
