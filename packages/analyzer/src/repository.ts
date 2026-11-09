import { matchesGlob } from './config';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_ENGINE, IGNORED_DIRECTORIES, type ComparisonOptions, type EngineProfile, type EvidenceComparison, type EvidenceSourceState } from './contracts';
import {
  BaselineSourceError,
  GraphentraError,
  DirtySourceError,
  GitExecutionError,
  GitNotFoundError,
  InvalidTargetError,
  RevisionError,
} from './errors';
import { isAnalyzableFile } from './technical-graph';

export interface RepositoryContext {
  projectRoot: string;
  excludePaths: string[];
  includesPath(file: string): boolean;
  listFiles(untracked?: boolean): string[];
  /** Project-relative files in the tree of `baseSha` (included paths only), sorted. */
  listBaselineFiles(baseSha: string): string[];
  trackedState(): string;
  gitRepositoryRoot: string;
  projectInsideRepository: string;
  comparison: EvidenceComparison;
  sourceState: Omit<EvidenceSourceState, 'contentIdentity'>;
  normalizeProjectPath(filePath: string): string;
  gitPathToProjectPath(gitFile: string): string;
  getGitDiff(): string;
  getBaselineSource(oldFile: string, baseSha: string): string;
  /** Raw bytes of a base-revision blob, so size, binary and encoding checks see what Git stores. */
  getBaselineBlob(oldFile: string, baseSha: string): Uint8Array;
  /**
   * Reads many base-revision blobs in two `git cat-file --batch*` calls (per chunk) and caches them, so
   * later getBaselineBlob/getBaselineSource calls for these paths spawn nothing. Blobs over `maxFileBytes`,
   * missing paths and unusual names are left to the per-file path, which keeps the exact errors.
   */
  prefetchBaseline(baseSha: string, files: string[], maxFileBytes?: number): void;
  executeGit(args: string[], cwd?: string): string;
  verifyHeadUnchanged(): void;
  calculateWorkingTreeContentIdentity(analyzedFiles: string[]): string;
  checkAttributes(files: string[]): Map<string, { generated?: boolean; vendored?: boolean }>;
}

export function createRepositoryContext(
  projectRootInput: string,
  comparisonOptions: ComparisonOptions,
  options: { gitTimeoutMs?: number; excludePaths?: string[]; engine?: EngineProfile;
    /** Glob exclusions (graphentra.yml `ignore`, schema 3.0 only); a match also excludes everything below it. */
    excludeGlobs?: string[] } = {},
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
  function runGit(args: string[], cwd: string, encoding: 'utf8' | 'buffer'): string | Buffer {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    try {
      return execFileSync('git', ['--literal-pathspecs', ...args], {
        cwd,
        env,
        encoding,
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

  function executeGit(args: string[], cwd: string = projectRoot): string {
    return runGit(args, cwd, 'utf8') as string;
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

  const prefixExcludes = [...new Set((options.excludePaths ?? []).map(value =>
    path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '')))].sort();
  const excludeGlobs = [...new Set(options.excludeGlobs ?? [])].sort();
  const excludePaths = excludeGlobs.length === 0 ? prefixExcludes : [...new Set([...prefixExcludes, ...excludeGlobs])].sort();
  function includesPath(file: string): boolean {
    return !file.split('/').some(part => IGNORED_DIRECTORIES.has(part)) &&
      !prefixExcludes.some(excluded => excluded === '.' || file === excluded || file.startsWith(`${excluded}/`)) &&
      !excludeGlobs.some(glob => matchesGlob(file, glob) || matchesGlob(file, `${glob.replace(/\/+$/, '')}/**`));
  }
  const targetFilter = ['--', projectInsideRepository];
  function listFiles(untracked = false): string[] {
    return executeGit(['ls-files', '-z', ...(untracked ? ['--others', '--exclude-standard'] : ['--cached']),
      ...targetFilter], gitRepositoryRoot).split('\0').filter(Boolean)
      .map(gitPathToProjectPath).filter(includesPath).sort();
  }
  function listBaselineFiles(baseSha: string): string[] {
    const scoped = projectInsideRepository === '.' ? [] : ['--', projectInsideRepository];
    return executeGit(['ls-tree', '-r', '-z', '--name-only', baseSha, ...scoped], gitRepositoryRoot)
      .split('\0').filter(file => file && (projectInsideRepository === '.' || file.startsWith(`${projectInsideRepository}/`)))
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
    const untrackedFiles = listFiles(true).filter(file => isAnalyzableFile(file, options.engine ?? DEFAULT_ENGINE));

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

  const baselineCache = new Map<string, Map<string, Buffer>>();
  const toRepoPath = (file: string) => projectInsideRepository !== '.' ? path.posix.join(projectInsideRepository, file) : file;
  const cachedBlob = (repoRelPath: string, baseSha: string): Buffer | undefined => baselineCache.get(baseSha)?.get(repoRelPath);

  function runCatFile(mode: '--batch' | '--batch-check', specs: string[], maxBuffer: number): Buffer | undefined {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const result = spawnSync('git', ['--literal-pathspecs', 'cat-file', mode], {
      cwd: gitRepositoryRoot, env, input: `${specs.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer,
    });
    // Any failure leaves the cache untouched; callers then read file by file with the original errors.
    return result.error || result.status !== 0 ? undefined : result.stdout;
  }

  const PREFETCH_CHUNK_PATHS = 2000;
  const PREFETCH_CHUNK_BYTES = 256 * 1024 * 1024;
  function prefetchBaseline(baseSha: string, files: string[], maxFileBytes = Infinity): void {
    const bucket = baselineCache.get(baseSha) ?? new Map<string, Buffer>();
    baselineCache.set(baseSha, bucket);
    // A newline would split the request line, so such names stay on the per-file path.
    const paths = [...new Set(files.map(toRepoPath))].filter(file => !file.includes('\n') && !bucket.has(file));
    for (let from = 0; from < paths.length; from += PREFETCH_CHUNK_PATHS) {
      const chunk = paths.slice(from, from + PREFETCH_CHUNK_PATHS);
      // Pass 1: sizes only, so oversize blobs are never read into memory.
      const checked = runCatFile('--batch-check', chunk.map(file => `${baseSha}:${file}`), 64 * 1024 * 1024);
      if (!checked) continue;
      const lines = checked.toString('utf8').split('\n');
      const wanted: Array<{ file: string; size: number }> = [];
      chunk.forEach((file, index) => {
        const match = /^[0-9a-f]+ blob (\d+)$/.exec(lines[index] ?? '');
        if (match && Number(match[1]) <= maxFileBytes) wanted.push({ file, size: Number(match[1]) });
      });
      // Pass 2: contents of the in-limit blobs, split further so one call never holds too many bytes.
      for (let start = 0; start < wanted.length;) {
        let end = start;
        let bytes = 0;
        while (end < wanted.length && (end === start || bytes + wanted[end].size <= PREFETCH_CHUNK_BYTES)) bytes += wanted[end++].size;
        const group = wanted.slice(start, end);
        start = end;
        const output = runCatFile('--batch', group.map(entry => `${baseSha}:${entry.file}`),
          bytes + group.length * 256 + 1024 * 1024);
        if (!output) continue;
        let offset = 0;
        for (const entry of group) {
          const newline = output.indexOf(0x0a, offset);
          if (newline === -1) break;
          const header = /^[0-9a-f]+ blob (\d+)$/.exec(output.toString('latin1', offset, newline));
          if (!header) { offset = newline + 1; continue; }
          const size = Number(header[1]);
          if (size !== entry.size || newline + 1 + size > output.length) break;
          bucket.set(entry.file, Buffer.from(output.subarray(newline + 1, newline + 1 + size)));
          offset = newline + 1 + size + 1;
        }
      }
    }
  }

  function getBaselineSource(oldFile: string, baseSha: string): string {
    const repoRelPath = toRepoPath(oldFile);
    const cached = cachedBlob(repoRelPath, baseSha);
    if (cached) return cached.toString('utf8');

    try {
      return executeGit(['show', `${baseSha}:${repoRelPath}`], gitRepositoryRoot);
    } catch (error: any) {
      throw new BaselineSourceError(
        `Failed to read baseline source for "${oldFile}" at commit ${baseSha}: ${error?.message || String(error)}`,
      );
    }
  }

  function getBaselineBlob(oldFile: string, baseSha: string): Buffer {
    const repoRelPath = toRepoPath(oldFile);
    const cached = cachedBlob(repoRelPath, baseSha);
    if (cached) return cached;
    try {
      return runGit(['show', `${baseSha}:${repoRelPath}`], gitRepositoryRoot, 'buffer') as Buffer;
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

  /** linguist-generated / linguist-vendored from .gitattributes, keyed by project path. */
  function checkAttributes(files: string[]): Map<string, { generated?: boolean; vendored?: boolean }> {
    const result = new Map<string, { generated?: boolean; vendored?: boolean }>();
    if (files.length === 0) return result;
    const repoPaths = files.map(file => projectInsideRepository === '.' ? file : path.posix.join(projectInsideRepository, file));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const output = execFileSync('git', ['check-attr', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'], {
      cwd: gitRepositoryRoot, env, input: repoPaths.join('\0'), encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024,
    });
    const fields = output.split('\0');
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const [repoPath, attribute, value] = [fields[index], fields[index + 1], fields[index + 2]];
      if (value === 'unspecified' || value === 'unset' || value === 'false') continue;
      const file = files[repoPaths.indexOf(repoPath)];
      if (file === undefined) continue;
      const entry = result.get(file) ?? {};
      if (attribute === 'linguist-generated') entry.generated = true;
      else entry.vendored = true;
      result.set(file, entry);
    }
    return result;
  }

  return {
    projectRoot,
    excludePaths,
    includesPath,
    listFiles,
    listBaselineFiles,
    trackedState,
    gitRepositoryRoot,
    projectInsideRepository,
    comparison,
    sourceState,
    normalizeProjectPath,
    gitPathToProjectPath,
    getGitDiff,
    getBaselineSource,
    getBaselineBlob,
    prefetchBaseline,
    executeGit,
    verifyHeadUnchanged,
    calculateWorkingTreeContentIdentity,
    checkAttributes,
  };
}
