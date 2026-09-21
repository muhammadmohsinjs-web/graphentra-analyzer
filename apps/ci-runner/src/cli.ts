#!/usr/bin/env node
import * as path from 'node:path';
import { CI_RUNNER_VERSION } from './contracts';
import { analyzeAndSubmit, resubmitEvidenceFile } from './runner';

export async function runCi(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Graphentra CI Runner v${CI_RUNNER_VERSION}
Deterministic analysis invocation and backend evidence submission adapter.

Usage:
  graphentra-ci [options]

Options:
  --target <dir>         Repository directory (default: current working directory)
  --base <ref>           Base Git ref (commit, branch, or tag)
  --head <ref>           Head Git ref (commit, branch, or tag)
  --working-tree         Analyze uncommitted working tree changes
  --backend-url <url>    Backend API URL (or GRAPHENTRA_BACKEND_URL env)
  --token <token>        Submission Bearer token (or GRAPHENTRA_TOKEN env)
  --repo <name>          Repository identifier, e.g. "org/repo" (or GITHUB_REPOSITORY env)
  --pr <number>          Pull request number
  --resubmit <file>      Resubmit an existing valid evidence.json file without re-analyzing
  --output <path>        Path or directory to write evidence.json
  --help, -h             Show this help message
  --version, -v          Show runner version
`);
      return;
    }
    if (arg === '--version' || arg === '-v') {
      console.log(CI_RUNNER_VERSION);
      return;
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        values.set(key, val);
      } else if (arg === '--working-tree') {
        flags.add('working-tree');
      } else {
        const key = arg.slice(2);
        const val = argv[++i];
        if (!val || val.startsWith('--')) {
          console.error(`Option --${key} requires a value.`);
          process.exit(1);
        }
        values.set(key, val);
      }
    }
  }

  const backendUrl = values.get('backend-url') ?? process.env.GRAPHENTRA_BACKEND_URL;
  const token = values.get('token') ?? process.env.GRAPHENTRA_TOKEN ?? process.env.GRAPHENTRA_API_KEY;
  const repoName = values.get('repo') ?? process.env.GITHUB_REPOSITORY;
  const prNumStr = values.get('pr');
  const prNumber = prNumStr ? parseInt(prNumStr, 10) : undefined;
  const resubmitPath = values.get('resubmit');

  if (!backendUrl) {
    console.error('❌ Backend URL is required (--backend-url or GRAPHENTRA_BACKEND_URL env).');
    process.exit(1);
  }
  if (!token) {
    console.error('❌ Submission token is required (--token or GRAPHENTRA_TOKEN env).');
    process.exit(1);
  }
  if (!repoName) {
    console.error('❌ Repository name is required (--repo or GITHUB_REPOSITORY env).');
    process.exit(1);
  }

  const repository = { name: repoName };
  const pullRequest = prNumber !== undefined ? { number: prNumber } : undefined;

  if (resubmitPath) {
    try {
      console.log(`\n📤 Resubmitting evidence file: ${resubmitPath}`);
      const submission = await resubmitEvidenceFile({
        evidencePath: path.resolve(resubmitPath),
        repository,
        pullRequest,
        backendUrl,
        token,
      });
      console.log(`✅ Evidence submitted successfully! Run ID: ${submission.id} (status: ${submission.status})\n`);
      return;
    } catch (error: any) {
      console.error(`\n❌ Resubmission failed: ${error?.message || String(error)}\n`);
      process.exit(1);
    }
  }

  const target = path.resolve(values.get('target') ?? process.cwd());
  const isWorkingTree = flags.has('working-tree');
  const base = values.get('base') ?? (isWorkingTree ? undefined : process.env.BASE_SHA?.trim() ?? 'HEAD~1');
  const head = values.get('head') ?? (isWorkingTree ? undefined : process.env.HEAD_SHA?.trim() ?? 'HEAD');

  const comparison = isWorkingTree
    ? { mode: 'working-tree' as const, base }
    : { mode: 'commit' as const, base: base!, head: head! };

  try {
    console.log(`\n🚀 Analyzing repository: ${target}`);
    const result = await analyzeAndSubmit({
      target,
      comparison,
      repository,
      pullRequest,
      backendUrl,
      token,
      outputEvidencePath: values.get('output'),
    });

    console.log(`\n✅ Deterministic evidence saved to: ${result.evidencePath}`);
    console.log(`✅ Analysis submitted to backend: Run ID: ${result.submission.id} (status: ${result.submission.status})\n`);
  } catch (error: any) {
    console.error(`\n❌ CI runner failed: ${error?.message || String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  void runCi();
}
