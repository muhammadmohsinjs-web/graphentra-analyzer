import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { compareStrings } from './deterministic';
import { DEFAULT_ENGINE, type DiagnosticItem, type EngineProfile } from './contracts';
import type { RepositoryContext } from './repository';
import { isAnalyzableFile } from './technical-graph';
import { bracketNestingDepth, DEFAULT_INPUT_LIMITS, inspectContent, MAX_NESTING_DEPTH, type InputLimits, type SkippedInput } from './input-limits';

/**
 * Compiler inputs for the base revision, served from Git objects. Unlike captureSourceSnapshot it records nothing:
 * base bytes must never reach the head snapshot's content identity.
 */
export function createBaselineSnapshot(
  repo: RepositoryContext,
  baseSha: string,
  engine: EngineProfile = DEFAULT_ENGINE,
  headCompilerOptions: ts.CompilerOptions = {},
  limits: InputLimits = DEFAULT_INPUT_LIMITS,
) {
  const standardLibraryRoot = path.dirname(ts.getDefaultLibFilePath({}));
  const inside = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  const allNames = repo.listBaselineFiles(baseSha);
  const baselineFiles = new Set(allNames);
  const directories = new Set<string>(['']);
  for (const name of allNames) {
    for (let dir = path.posix.dirname(name); dir !== '.' && !directories.has(dir); dir = path.posix.dirname(dir)) directories.add(dir);
  }
  // One batched read for everything the compiler is about to ask for; other files fall back to per-file reads.
  repo.prefetchBaseline(baseSha, allNames.filter(name => isAnalyzableFile(name, engine) ||
    ['tsconfig.json', 'jsconfig.json', 'package.json'].includes(path.posix.basename(name))), limits.maxFileBytes);
  const cache = new Map<string, string | undefined>();
  const skippedByFile = new Map<string, SkippedInput>();
  const projectRelative = (file: string): string | undefined => {
    const absolute = path.resolve(file);
    return inside(repo.projectRoot, absolute) ? path.relative(repo.projectRoot, absolute).split(path.sep).join('/') : undefined;
  };
  function readFile(file: string): string | undefined {
    const absolute = path.resolve(file);
    if (!cache.has(absolute)) {
      let content: string | undefined;
      if (inside(standardLibraryRoot, absolute)) {
        try { content = fs.readFileSync(absolute, 'utf8'); } catch { content = undefined; }
      } else {
        const relative = projectRelative(absolute);
        if (relative !== undefined && baselineFiles.has(relative)) {
          // Submodule entries appear in the tree but have no blob.
          let bytes: Buffer | undefined;
          try { bytes = repo.getBaselineBlob(relative, baseSha); } catch { bytes = undefined; }
          // Same size, binary and encoding limits as the head snapshot; rejected files are absent to the compiler.
          const reason = bytes === undefined ? 'ok' : bytes.length > limits.maxFileBytes ? 'too_large' : inspectContent(bytes);
          if (reason !== 'ok') skippedByFile.set(relative, { file: relative, reason });
          else content = bytes?.toString('utf8');
        }
      }
      cache.set(absolute, content);
    }
    return cache.get(absolute);
  }
  const fileExists = (file: string) => readFile(file) !== undefined;
  const directoryExists = (directory: string) => {
    const absolute = path.resolve(directory);
    if (inside(standardLibraryRoot, absolute)) return ts.sys.directoryExists(absolute);
    const relative = projectRelative(absolute);
    return relative !== undefined && directories.has(relative === '.' ? '' : relative);
  };

  const diagnostics: DiagnosticItem[] = [];
  let configPath = path.join(repo.projectRoot, 'tsconfig.json');
  let configText = readFile(configPath);
  if (engine === 'extended' && configText === undefined) {
    const jsConfigPath = path.join(repo.projectRoot, 'jsconfig.json');
    const jsConfigText = readFile(jsConfigPath);
    if (jsConfigText !== undefined) { configPath = jsConfigPath; configText = jsConfigText; }
  }
  let compilerOptions: ts.CompilerOptions | undefined;
  if (configText !== undefined) {
    const config = ts.parseConfigFileTextToJson(configPath, configText);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config,
        { ...ts.sys, readFile, fileExists, readDirectory: () => [] }, repo.projectRoot);
      if (!parsed.errors.some(error => error.code !== 18003)) {
        compilerOptions = { ...parsed.options, ...(engine === 'extended' ? { allowJs: true, checkJs: parsed.options.checkJs ?? false } : {}),
          noEmit: true, skipLibCheck: true };
      }
    }
  }
  if (!compilerOptions) {
    compilerOptions = headCompilerOptions;
    diagnostics.push({ code: 'BASELINE_CONFIG_FALLBACK', severity: 'info',
      message: `No usable tsconfig.json/jsconfig.json at base revision ${baseSha}; head compiler options were used.` });
  }

  // Deterministic admission: sorted paths, the first files that fit within the count and byte limits are kept.
  const admitted: string[] = [];
  let totalBytes = 0;
  for (const name of allNames.filter(file => isAnalyzableFile(file, engine))) {
    const absolute = path.join(repo.projectRoot, name);
    const content = readFile(absolute);
    if (content === undefined) continue;
    const size = Buffer.byteLength(content);
    if (admitted.length >= limits.maxFiles || totalBytes + size > limits.maxTotalBytes) {
      cache.set(path.resolve(absolute), undefined);
      skippedByFile.set(name, { file: name, reason: 'input_limit' });
      continue;
    }
    admitted.push(name);
    totalBytes += size;
  }
  const files = admitted.map(file => path.join(repo.projectRoot, file));
  const host = ts.createCompilerHost(compilerOptions);
  host.readFile = readFile;
  host.fileExists = fileExists;
  host.directoryExists = directoryExists;
  host.getDirectories = () => [];
  host.realpath = file => file;
  host.getCurrentDirectory = () => repo.projectRoot;
  host.getSourceFile = (file, languageVersion) => {
    const content = readFile(file);
    if (content === undefined) return undefined;
    const relative = projectRelative(path.resolve(file));
    const dropUnparsable = () => {
      skippedByFile.set(relative!, { file: relative!, reason: 'parse_failed' });
      cache.set(path.resolve(file), undefined);
      return undefined;
    };
    // D14: nesting is measured on tokens before parsing, as in the head snapshot.
    if (relative !== undefined && bracketNestingDepth(content) > MAX_NESTING_DEPTH) return dropUnparsable();
    try { return ts.createSourceFile(file, content, languageVersion, true); }
    catch (error) {
      // Last-resort safety net: pathologically nested source overflows the parser's stack.
      if (!(error instanceof RangeError) || relative === undefined) throw error;
      return dropUnparsable();
    }
  };
  return {
    files, compilerOptions, host, diagnostics,
    get skipped(): SkippedInput[] { return [...skippedByFile.values()].sort((a, b) => compareStrings(a.file, b.file)); },
  };
}
