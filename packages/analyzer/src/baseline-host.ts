import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { DEFAULT_ENGINE, type DiagnosticItem, type EngineProfile } from './contracts';
import type { RepositoryContext } from './repository';
import { isAnalyzableFile } from './technical-graph';

/**
 * Compiler inputs for the base revision, served from Git objects. Unlike captureSourceSnapshot it records nothing:
 * base bytes must never reach the head snapshot's content identity.
 */
export function createBaselineSnapshot(
  repo: RepositoryContext,
  baseSha: string,
  engine: EngineProfile = DEFAULT_ENGINE,
  headCompilerOptions: ts.CompilerOptions = {},
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
  const cache = new Map<string, string | undefined>();
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
          try { content = repo.getBaselineSource(relative, baseSha); } catch { content = undefined; }
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

  const files = allNames.filter(file => isAnalyzableFile(file, engine)).map(file => path.join(repo.projectRoot, file));
  const host = ts.createCompilerHost(compilerOptions);
  host.readFile = readFile;
  host.fileExists = fileExists;
  host.directoryExists = directoryExists;
  host.getDirectories = () => [];
  host.realpath = file => file;
  host.getCurrentDirectory = () => repo.projectRoot;
  host.getSourceFile = (file, languageVersion) => {
    const content = readFile(file);
    return content === undefined ? undefined : ts.createSourceFile(file, content, languageVersion, true);
  };
  return { files, compilerOptions, host, diagnostics };
}
