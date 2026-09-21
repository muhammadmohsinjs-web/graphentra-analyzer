import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IGNORED_DIRECTORIES, type ComparisonOptions, type EvidenceComparison, type EvidenceSourceState } from './contracts';
import {
  BaselineSourceError,
  GraphentraError,
  DirtySourceError,
  GitExecutionError,
  GitNotFoundError,
  InvalidTargetError,
  RevisionError,
} from './errors';
import { isTypeScriptFile } from './technical-graph';

export interface RepositoryContext {
  projectRoot: string;
  excludePaths: string[];
  includesPath(file: string): boolean;
  listFiles(untracked?: boolean): string[];
  trackedState(): string;
  gitRepositoryRoot: string;
  projectInsideRepository: string;
  comparison: EvidenceComparison;
  sourceState: Omit<EvidenceSourceState, 'contentIdentity'>;
  normalizeProjectPath(filePath: string): string;
  gitPathToProjectPath(gitFile: string): string;
  getGitDiff(): string;
  getBaselineSource(oldFile: string, baseSha: string): string;
  executeGit(args: string[], cwd?: string): string;
  verifyHeadUnchanged(): void;
  calculateWorkingTreeContentIdentity(analyzedFiles: string[]): string;
}

export function createRepositoryContext(
  projectRootInput: string,
  comparisonOptions: ComparisonOptions,
  options: { gitTimeoutMs?: number; excludePaths?: string[] } = {},
): RepositoryContext {
  if (!comparisonOptions || typeof comparisonOptions !== 'object' ||
      !['commit', 'working-tree'].includes(comparisonOptions.mode)) {
    throw new RevisionError('An explicit commit or working-tree comparison is required.');
  }
  const allowed = comparisonOptions.mode === 'commit' ? ['mode', 'base', 'head'] : ['mode', 'base'];
  if (Object.keys(comparisonOptions).some(key => !allowed.includes(key))) {
    throw new RevisionError('Comparison contains contradictory or unknown keys.');
  }
  for (const key of allowed.filter(key => key !== 'mode')) {
    const value = (comparisonOptions as unknown as Record<string, unknown>)[key];
    if (value === undefined && comparisonOptions.mode === 'working-tree') continue;
    if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-') || value.includes('\0')) {
      throw new RevisionError('Comparison revisions must be nonblank, non-option strings.');
    }
  }
  const timeoutMs = options.gitTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new GraphentraError('gitTimeoutMs must be a positive bounded integer.', 'INVALID_OPTIONS');
  }
  if (options.excludePaths !== undefined && (!Array.isArray(options.excludePaths) ||
      options.excludePaths.some(value => typeof value !== 'string' || !value.trim() ||
        path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\0') ||
        value.replace(/\\/g, '/').split('/').includes('..')))) {
    throw new GraphentraError('Exclusions must be target-relative paths without parent traversal.', 'INVALID_OPTIONS');
  }

  // 1. Verify target directory exists
  const rawTarget = path.resolve(projectRootInput);
  if (!fs.existsSync(rawTarget)) {
    throw new InvalidTargetError(rawTarget, 'Directory does not exist.');
  }
  const stat = fs.statSync(rawTarget);
  if (!stat.isDirectory()) {
    throw new InvalidTargetError(rawTarget, 'Path is not a directory.');
  }

  // Canonicalize realpath to handle symlinks (such as macOS /var -> /private/var)
  let projectRoot: string;
  try {
    projectRoot = fs.realpathSync(rawTarget);
  } catch {
    projectRoot = rawTarget;
  }

  // 2. Verify git is available and resolve git root
  function executeGit(args: string[], cwd: string = projectRoot): string {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    try {
      return execFileSync('git', ['--literal-pathspecs', ...args], {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new GitNotFoundError();
      }
      if (error?.code === 'ETIMEDOUT') {
        throw new GraphentraError('Git operation timed out.', 'GIT_TIMEOUT', error);
      }
      const stderr = error?.stderr ? String(error.stderr).trim() : '';
      const command = `git ${args.join(' ')}`;
      throw new GitExecutionError(
        'Git operation failed.',
        command,
        stderr,
      );
    }
  }

  let rawGitRoot: string;
  try {
    rawGitRoot = executeGit(['rev-parse', '--show-toplevel']).trimEnd();
  } catch (error) {
    if (!(error instanceof GitExecutionError)) throw error;
    throw new InvalidTargetError(projectRoot, 'Target is not inside a Git repository.');
  }

  let gitRepositoryRoot: string;
  try {
    gitRepositoryRoot = fs.realpathSync(rawGitRoot);
  } catch {
    gitRepositoryRoot = rawGitRoot;
  }

  const projectInsideRepository = path
    .relative(gitRepositoryRoot, projectRoot)
    .replace(/\\/g, '/') || '.';

  if (projectInsideRepository.startsWith('..')) {
    throw new InvalidTargetError(
      projectRoot,
      `Resolved target is outside the Git repository root "${gitRepositoryRoot}".`,
    );
  }

  const excludePaths = [...new Set((options.excludePaths ?? []).map(value =>
    path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '')))].sort();
  function includesPath(file: string): boolean {
    return !file.split('/').some(part => IGNORED_DIRECTORIES.has(part)) &&
      !excludePaths.some(excluded => excluded === '.' || file === excluded || file.startsWith(`${excluded}/`));
  }
  const targetFilter = ['--', projectInsideRepository];
  function listFiles(untracked = false): string[] {
    return executeGit(['ls-files', '-z', ...(untracked ? ['--others', '--exclude-standard'] : ['--cached']),
      ...targetFilter], gitRepositoryRoot).split('\0').filter(Boolean)
      .map(gitPathToProjectPath).filter(includesPath).sort();
  }
  function trackedState(): string {
    const names = [[], ['--cached']].flatMap(extra => executeGit([
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3',
      '--name-only', '-z', ...extra, 'HEAD', ...targetFilter], gitRepositoryRoot)
      .split('\0').filter(Boolean).map(gitPathToProjectPath).filter(includesPath));
    return [...new Set(names)].sort().join('\0');
  }

  // 3. Resolve HEAD commit SHA
  let checkoutSha: string;
  try {
    checkoutSha = executeGit(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], gitRepositoryRoot).trim();
  } catch (error) {
    if (!(error instanceof GitExecutionError)) throw error;
    throw new RevisionError('Cannot resolve checkout HEAD commit.', 'MISSING_HISTORY');
  }

  function resolveRevision(ref: string): string {
    try {
      return executeGit(['rev-parse', '--verify', '--end-of-options', `${ref.trim()}^{commit}`], gitRepositoryRoot).trim();
    } catch (error) {
      if (!(error instanceof GitExecutionError)) throw error;
      const shallow = executeGit(['rev-parse', '--is-shallow-repository'], gitRepositoryRoot).trim() === 'true';
      throw new RevisionError(shallow
        ? 'Revision is unavailable in shallow history. Fetch the comparison history before analysis.'
        : 'Revision does not identify an available commit.', shallow ? 'MISSING_HISTORY' : 'INVALID_REVISION');
    }
  }

  let comparison: EvidenceComparison;
  let sourceState: Omit<EvidenceSourceState, 'contentIdentity'>;

  if (comparisonOptions.mode === 'commit') {
    const { base, head } = comparisonOptions;
    if (!base || typeof base !== 'string' || !base.trim()) {
      throw new RevisionError(
        'Commit mode requires a non-empty "base" revision.',
        'INVALID_REVISION',
      );
    }
    if (!head || typeof head !== 'string' || !head.trim()) {
      throw new RevisionError(
        'Commit mode requires a non-empty "head" revision.',
        'INVALID_REVISION',
      );
    }

    const resolvedBaseSha = resolveRevision(base);
    const resolvedHeadSha = resolveRevision(head);

    // Checkout HEAD alignment
    if (checkoutSha !== resolvedHeadSha) {
      throw new RevisionError(
        `Checkout HEAD (${checkoutSha}) does not match resolved head ref "${head}" (${resolvedHeadSha}). Commit-mode analysis requires checkout to match the comparison head.`,
        'REVISION_MISMATCH',
      );
    }

    if (trackedState()) {
      throw new DirtySourceError('Target has uncommitted tracked changes.', 'DIRTY_TRACKED_SOURCE');
    }
    const untrackedFiles = listFiles(true).filter(isTypeScriptFile);

    if (untrackedFiles.length > 0) {
      throw new DirtySourceError(
        `Target directory has untracked TypeScript source files that would alter commit-mode analysis: ${untrackedFiles.join(', ')}. Commit or remove them, or use working-tree mode.`,
        'DIRTY_UNTRACKED_SOURCE',
      );
    }

    comparison = {
      mode: 'commit',
      requestedBase: base,
      requestedHead: head,
      resolvedBaseSha,
      resolvedHeadSha,
      comparedTo: `\`${head}\``,
    };

    sourceState = {
      checkoutSha,
      isTrackedDirty: false,
      untrackedSourcePolicy: 'excluded',
    };
  } else if (comparisonOptions.mode === 'working-tree') {
    const base = comparisonOptions.base?.trim() || 'HEAD';

    const resolvedBaseSha = resolveRevision(base);

    const isTrackedDirty = Boolean(trackedState());

    comparison = {
      mode: 'working-tree',
      requestedBase: comparisonOptions.base,
      resolvedBaseSha,
      comparedTo: 'the working tree',
    };

    sourceState = {
      checkoutSha,
      isTrackedDirty,
      untrackedSourcePolicy: 'included',
    };
  } else {
    throw new RevisionError(
      `Unsupported comparison mode: "${(comparisonOptions as any).mode}". Expected "commit" or "working-tree".`,
      'INVALID_REVISION',
    );
  }

  function normalizeProjectPath(filePath: string): string {
    return path.relative(projectRoot, filePath).replace(/\\/g, '/');
  }

  function gitPathToProjectPath(gitFile: string): string {
    const normalized = gitFile;
    if (
      projectInsideRepository !== '.' &&
      normalized.startsWith(`${projectInsideRepository}/`)
    ) {
      return normalized.slice(projectInsideRepository.length + 1);
    }
    return normalized;
  }

  function getGitDiff(): string {
    const target = projectInsideRepository !== '.' ? projectInsideRepository : '.';
    const range =
      comparison.mode === 'commit'
        ? [comparison.resolvedBaseSha, comparison.resolvedHeadSha!]
        : [comparison.resolvedBaseSha];

    return executeGit(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames=50%',
        '-l1000',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-color',
        '--unified=3',
        ...range,
        '--',
        target,
      ],
      gitRepositoryRoot,
    );
  }

  function getBaselineSource(oldFile: string, baseSha: string): string {
    const repoRelPath =
      projectInsideRepository !== '.'
        ? path.posix.join(projectInsideRepository, oldFile)
        : oldFile;

    try {
      return executeGit(['show', `${baseSha}:${repoRelPath}`], gitRepositoryRoot);
    } catch (error: any) {
      throw new BaselineSourceError(
        `Failed to read baseline source for "${oldFile}" at commit ${baseSha}: ${error?.message || String(error)}`,
      );
    }
  }

  function verifyHeadUnchanged(): void {
    const currentSha = executeGit(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], gitRepositoryRoot).trim();
    if (currentSha !== checkoutSha) {
      throw new GraphentraError(
        'Checkout HEAD changed during analysis. Mixed-state analysis rejected.',
        'SOURCE_CHANGED',
      );
    }
  }

  function calculateWorkingTreeContentIdentity(analyzedFiles: string[]): string {
    const hash = createHash('sha256');
    for (const relFile of analyzedFiles.sort()) {
      const fullPath = path.join(projectRoot, relFile);
      if (fs.existsSync(fullPath)) {
        hash.update(relFile);
        hash.update('\0');
        hash.update(fs.readFileSync(fullPath));
        hash.update('\0');
      }
    }
    return hash.digest('hex');
  }

  return {
    projectRoot,
    excludePaths,
    includesPath,
    listFiles,
    trackedState,
    gitRepositoryRoot,
    projectInsideRepository,
    comparison,
    sourceState,
    normalizeProjectPath,
    gitPathToProjectPath,
    getGitDiff,
    getBaselineSource,
    executeGit,
    verifyHeadUnchanged,
    calculateWorkingTreeContentIdentity,
  };
}
