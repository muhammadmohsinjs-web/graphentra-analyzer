import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { compareStrings } from './deterministic';
import { GraphentraError } from './errors';
import type { RepositoryContext } from './repository';
import { DEFAULT_ENGINE, type EngineProfile } from './contracts';
import { isAnalyzableFile } from './technical-graph';
import { DEFAULT_INPUT_LIMITS, inspectContent, type InputLimits, type SkippedInput, type SkipReason } from './input-limits';

/** Captures compiler reads and verifies them again before returning evidence. */
export function captureSourceSnapshot(
  repo: RepositoryContext,
  engine: EngineProfile = DEFAULT_ENGINE,
  limits: InputLimits = DEFAULT_INPUT_LIMITS,
) {
  const standardLibraryRoot = path.dirname(ts.getDefaultLibFilePath({}));
  /** Relative path with `/` separators, so the identity hash is the same on Windows. */
  const posixRelative = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/');
  const reads = new Map<string, Buffer | undefined>();
  const compilerPaths = new Map<string, string>();
  const inside = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  function checkPath(file: string) {
    const absolute = compilerPaths.get(path.resolve(file)) ?? path.resolve(file);
    if (!inside(repo.gitRepositoryRoot, absolute) && !inside(standardLibraryRoot, absolute)) {
      throw new GraphentraError('Compiler input is outside the repository. Move configuration and dependencies inside the repository.', 'UNSUPPORTED_EXTERNAL_INPUT');
    }
    if (fs.existsSync(absolute)) {
      const real = fs.realpathSync(absolute);
      if (!inside(repo.gitRepositoryRoot, real) && !inside(standardLibraryRoot, real)) {
        throw new GraphentraError('Compiler input symlink escapes the repository.', 'UNSUPPORTED_EXTERNAL_INPUT');
      }
    }
    return absolute;
  }
  // Inputs refused by the input limits: absent to the compiler, listed in `skipped`.
  const blocked = new Map<string, SkippedInput>();
  const skip = (absolute: string, reason: SkipReason) => {
    const inProject = inside(repo.projectRoot, absolute);
    const file = posixRelative(inProject ? repo.projectRoot : repo.gitRepositoryRoot, absolute);
    blocked.set(absolute, { file, reason });
  };
  /** Metadata-only classification: a symlink that leaves the repo or loops, an oversized file, or nothing to read. */
  function inspectPath(absolute: string): { reason?: 'symlink' | 'too_large'; size: number; missing?: true } {
    let real: string;
    try {
      fs.lstatSync(absolute);
      real = fs.realpathSync(absolute);
    } catch (error: any) {
      if (error.code === 'ELOOP') return { reason: 'symlink', size: 0 };
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { missing: true, size: 0 };
      throw error;
    }
    if (!inside(repo.gitRepositoryRoot, real) && !inside(standardLibraryRoot, real)) return { reason: 'symlink', size: 0 };
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { missing: true, size: 0 };
    return stat.size > limits.maxFileBytes ? { reason: 'too_large', size: stat.size } : { size: stat.size };
  }
  function readFile(file: string): string | undefined {
    const key = compilerPaths.get(path.resolve(file)) ?? path.resolve(file);
    if (blocked.has(key)) return undefined;
    const absolute = checkPath(file);
    if (!reads.has(absolute)) {
      // The standard library is trusted; everything inside the repository is subject to the input limits.
      const limited = inside(repo.gitRepositoryRoot, absolute);
      const info = limited ? inspectPath(absolute) : undefined;
      if (info?.reason) { skip(absolute, info.reason); return undefined; }
      if (info?.missing) reads.set(absolute, undefined);
      else {
        try { reads.set(absolute, fs.readFileSync(absolute)); }
        catch (error: any) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          reads.set(absolute, undefined);
        }
      }
      const bytes = reads.get(absolute);
      const content = limited && bytes ? inspectContent(bytes) : 'ok';
      // Rejected bytes stay in `reads` so identity and verify() still cover them.
      if (content !== 'ok') { skip(absolute, content); return undefined; }
    }
    return reads.get(absolute)?.toString('utf8');
  }
  function inventory() {
    return [...new Set([...repo.listFiles(), ...repo.listFiles(true)])]
      .filter(file => isAnalyzableFile(file, engine))
      .filter(file => { try { fs.lstatSync(path.join(repo.projectRoot, file)); return true; } catch { return false; } }).sort();
  }
  const candidates = inventory();
  // Deterministic admission: sorted paths, the first files that fit within the count and byte limits are kept.
  const names: string[] = [];
  let totalBytes = 0;
  for (const name of candidates) {
    const file = path.join(repo.projectRoot, name);
    const compilerPath = file.replace(/\\/g, '/');
    if (compilerPaths.has(compilerPath) && compilerPaths.get(compilerPath) !== file) {
      throw new GraphentraError('Source paths collide after compiler path normalization.', 'UNSUPPORTED_EXTERNAL_INPUT');
    }
    compilerPaths.set(compilerPath, file);
    const info = inspectPath(file);
    if (info.missing) continue;
    if (info.reason) { skip(file, info.reason); continue; }
    if (names.length >= limits.maxFiles || totalBytes + info.size > limits.maxTotalBytes) { skip(file, 'input_limit'); continue; }
    readFile(file);
    if (blocked.has(file)) continue;
    names.push(name);
    totalBytes += info.size;
  }
  const files = names.map(file => path.join(repo.projectRoot, file));
  const initialDiff = repo.getGitDiff();
  const initialTrackedState = repo.trackedState();
  let configPath = path.join(repo.projectRoot, 'tsconfig.json');
  let configText = readFile(configPath);
  // Extended engine: a jsconfig.json is used only when there is no tsconfig.json; it is read through the captured readFile.
  if (engine === 'extended' && configText === undefined) {
    const jsConfigPath = path.join(repo.projectRoot, 'jsconfig.json');
    const jsConfigText = readFile(jsConfigPath);
    if (jsConfigText !== undefined) { configPath = jsConfigPath; configText = jsConfigText; }
  }
  const fileExists = (file: string) => {
    // Do not let module resolution search unrelated parent workspaces.
    if (!inside(repo.gitRepositoryRoot, path.resolve(file)) && !inside(standardLibraryRoot, path.resolve(file))) return false;
    return readFile(file) !== undefined;
  };
  const directoryExists = (directory: string) =>
    (inside(repo.gitRepositoryRoot, directory) || inside(standardLibraryRoot, directory)) && ts.sys.directoryExists(directory);
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, jsx: ts.JsxEmit.ReactJSX,
  };
  if (configText !== undefined) {
    const config = ts.parseConfigFileTextToJson(configPath, configText);
    if (config.error) throw new GraphentraError('Invalid target tsconfig.json.', 'INVALID_OPTIONS');
    const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readFile, fileExists }, repo.projectRoot);
    // Empty include sets are permitted: Git inventory determines extraction scope.
    if (parsed.errors.some(error => error.code !== 18003)) {
      throw new GraphentraError('Invalid or unavailable compiler configuration.', 'INVALID_OPTIONS');
    }
    compilerOptions = parsed.options;
  }
  if (engine === 'extended') compilerOptions = { ...compilerOptions, allowJs: true, checkJs: compilerOptions.checkJs ?? false };
  compilerOptions = { ...compilerOptions, noEmit: true, skipLibCheck: true };
  const host = ts.createCompilerHost(compilerOptions);
  host.readFile = readFile;
  host.fileExists = fileExists;
  host.directoryExists = directoryExists;
  host.getCurrentDirectory = () => repo.projectRoot;
  host.getSourceFile = (file, languageVersion) => {
    const content = readFile(file);
    if (content === undefined) return undefined;
    try { return ts.createSourceFile(compilerPaths.get(file) ?? file, content, languageVersion, true); }
    catch (error) {
      // Pathologically nested source overflows the parser's stack: drop that file instead of crashing the run.
      if (!(error instanceof RangeError)) throw error;
      skip(compilerPaths.get(path.resolve(file)) ?? path.resolve(file), 'parse_failed');
      return undefined;
    }
  };
  function identity() {
    const hash = createHash('sha256');
    const manifest = [...reads].map(([file, bytes]) => [
      inside(standardLibraryRoot, file) ? `typescript/${posixRelative(standardLibraryRoot, file)}`
        : `repository/${posixRelative(repo.gitRepositoryRoot, file)}`,
      bytes?.toString('base64') ?? null,
    ] as const).sort(([a], [b]) => compareStrings(a, b));
    hash.update(JSON.stringify(manifest));
    hash.update(JSON.stringify(names));
    // Skips change what was analyzed, so they are part of the identity; absent when nothing was skipped.
    if (blocked.size > 0) hash.update(JSON.stringify(skippedInputs()));
    return hash.digest('hex');
  }
  /** Sorted by file, then reason; read live because the compiler may skip more inputs after capture. */
  const skippedInputs = (): SkippedInput[] => [...blocked.values()]
    .sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.reason, b.reason));
  function verify() {
    repo.verifyHeadUnchanged();
    if (JSON.stringify(inventory()) !== JSON.stringify(candidates) || repo.getGitDiff() !== initialDiff ||
        repo.trackedState() !== initialTrackedState) {
      throw new GraphentraError('Source inventory or Git state changed during analysis.', 'SOURCE_CHANGED');
    }
    for (const [file, skipped] of blocked) {
      // Content rejections are covered by `reads`; size and symlink rejections are re-derived from metadata.
      if ((skipped.reason === 'too_large' || skipped.reason === 'symlink') && inspectPath(file).reason !== skipped.reason) {
        throw new GraphentraError('Compiler input changed during analysis.', 'SOURCE_CHANGED');
      }
    }
    for (const [file, bytes] of reads) {
      checkPath(file);
      let current: Buffer | undefined;
      try { current = fs.readFileSync(file); }
      catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      if (bytes === undefined ? current !== undefined : current === undefined || !bytes.equals(current)) {
        throw new GraphentraError('Compiler input changed during analysis.', 'SOURCE_CHANGED');
      }
    }
  }
  return {
    files, compilerOptions, host, readFile, gitDiff: initialDiff, identity, verify,
    get skipped(): SkippedInput[] { return skippedInputs(); },
  };
}
