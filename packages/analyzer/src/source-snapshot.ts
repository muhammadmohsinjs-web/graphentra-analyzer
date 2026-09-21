import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { GraphentraError } from './errors';
import type { RepositoryContext } from './repository';
import { isTypeScriptFile } from './technical-graph';

/** Captures compiler reads and verifies them again before returning evidence. */
export function captureSourceSnapshot(repo: RepositoryContext) {
  const standardLibraryRoot = path.dirname(ts.getDefaultLibFilePath({}));
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
  function readFile(file: string): string | undefined {
    const absolute = checkPath(file);
    if (!reads.has(absolute)) {
      try { reads.set(absolute, fs.readFileSync(absolute)); }
      catch (error: any) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        reads.set(absolute, undefined);
      }
    }
    return reads.get(absolute)?.toString('utf8');
  }
  function inventory() {
    return [...new Set([...repo.listFiles(), ...repo.listFiles(true)])]
      .filter(isTypeScriptFile).filter(file => fs.existsSync(path.join(repo.projectRoot, file))).sort();
  }
  const names = inventory();
  const files = names.map(file => path.join(repo.projectRoot, file));
  for (const file of files) {
    const compilerPath = file.replace(/\\/g, '/');
    if (compilerPaths.has(compilerPath) && compilerPaths.get(compilerPath) !== file) {
      throw new GraphentraError('Source paths collide after compiler path normalization.', 'UNSUPPORTED_EXTERNAL_INPUT');
    }
    compilerPaths.set(compilerPath, file);
    readFile(file);
  }
  const initialDiff = repo.getGitDiff();
  const initialTrackedState = repo.trackedState();
  const configPath = path.join(repo.projectRoot, 'tsconfig.json');
  const configText = readFile(configPath);
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
  compilerOptions = { ...compilerOptions, noEmit: true, skipLibCheck: true };
  const host = ts.createCompilerHost(compilerOptions);
  host.readFile = readFile;
  host.fileExists = fileExists;
  host.directoryExists = directoryExists;
  host.getCurrentDirectory = () => repo.projectRoot;
  host.getSourceFile = (file, languageVersion) => {
    const content = readFile(file);
    return content === undefined ? undefined : ts.createSourceFile(compilerPaths.get(file) ?? file, content, languageVersion, true);
  };
  function identity() {
    const hash = createHash('sha256');
    const manifest = [...reads].map(([file, bytes]) => [
      inside(standardLibraryRoot, file) ? `typescript/${path.relative(standardLibraryRoot, file)}`
        : `repository/${path.relative(repo.gitRepositoryRoot, file)}`,
      bytes?.toString('base64') ?? null,
    ] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    hash.update(JSON.stringify(manifest));
    hash.update(JSON.stringify(names));
    return hash.digest('hex');
  }
  function verify() {
    repo.verifyHeadUnchanged();
    if (JSON.stringify(inventory()) !== JSON.stringify(names) || repo.getGitDiff() !== initialDiff ||
        repo.trackedState() !== initialTrackedState) {
      throw new GraphentraError('Source inventory or Git state changed during analysis.', 'SOURCE_CHANGED');
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
  return { files, compilerOptions, host, readFile, gitDiff: initialDiff, identity, verify };
}
