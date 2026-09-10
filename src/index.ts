import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const ANALYZER_VERSION = '0.2.0';

const MAX_BLAST_DEPTH = 6;

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.graphentra']);

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * ============================================================
 * CORE TYPES
 * ============================================================
 */

interface Entity {
  id: string;

  kind: 'function';

  name: string;

  file: string;

  startLine: number;

  endLine: number;
}

interface Relation {
  from: string;

  to: string;

  type: 'CALLS';
}

interface ChangedFile {
  file: string;

  /**
   * Line numbers refer to the NEW version of the file.
   */
  changedLines: number[];

  addedCode: string[];

  removedCode: string[];

  diff: string;
}

interface ChangedEntity {
  entity: Entity;

  change: ChangedFile;
}

interface ImpactPath {
  target: Entity;

  depth: number;

  /**
   * Example:
   *
   * calculatePrice
   * -> applyPricing
   * -> buildOrderTotal
   * -> checkout
   */
  path: Entity[];
}

interface EntityImpact {
  changedEntity: Entity;

  change: ChangedFile;

  directDependents: Entity[];

  blastRadius: {
    totalAffectedEntities: number;

    entities: Entity[];

    paths: ImpactPath[];
  };

  terminalDependents: Entity[];
}

interface TechnicalGraph {
  schemaVersion: '1.0';

  repository: {
    root: string;

    headSha: string;

    workingTreeDirty: boolean;

    generatedAt: string;

    analyzerVersion: string;
  };

  capabilities: {
    language: 'typescript';

    entityKinds: ['function'];

    relationTypes: ['CALLS'];

    maxBlastDepth: number;
  };

  analyzedFiles: string[];

  entities: Entity[];

  relations: Relation[];
}

interface AnalysisResult {
  schemaVersion: '1.0';

  repository: {
    root: string;

    headSha: string;
  };

  analyzedFiles: string[];

  changedFiles: ChangedFile[];

  changedEntities: ChangedEntity[];

  impacts: EntityImpact[];

  limitations: string[];
}

/**
 * ============================================================
 * CLI INPUT
 * ============================================================
 *
 * GitHub Actions currently runs:
 *
 * npm run analyze -- ../demo-application
 */

const targetRepository = process.argv.slice(2).find(argument => !argument.startsWith('--'));

if (!targetRepository) {
  console.error('\n❌ Repository path is required.');
  console.error('Usage: npm run analyze -- <repository-path>\n');

  process.exit(1);
}

/**
 * This is the directory Graphentra should analyze.
 *
 * Example:
 *
 * /runner/work/.../demo-application
 */
const projectRoot = path.resolve(targetRepository);

if (!fs.existsSync(projectRoot)) {
  console.error(`\n❌ Repository does not exist: ${projectRoot}\n`);

  process.exit(1);
}

/**
 * ============================================================
 * GIT HELPERS
 * ============================================================
 */

function executeGit(args: string[], cwd: string = projectRoot): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',

    maxBuffer: 20 * 1024 * 1024,
  }).trimEnd();
}

/**
 * Find actual Git repository root.
 *
 * Currently this will be the same as projectRoot for
 * demo-application.
 *
 * Later this also allows Graphentra to support projects inside
 * monorepositories.
 */

let gitRepositoryRoot: string;

try {
  gitRepositoryRoot = executeGit(['rev-parse', '--show-toplevel']);
} catch {
  console.error(`\n❌ Target is not inside a Git repository: ${projectRoot}\n`);

  process.exit(1);
}

const projectInsideRepository = path.relative(gitRepositoryRoot, projectRoot).replace(/\\/g, '/');

function getHeadSha(): string {
  return executeGit(['rev-parse', 'HEAD'], gitRepositoryRoot);
}

function isWorkingTreeDirty(): boolean {
  const target = projectInsideRepository && projectInsideRepository !== '.' ? projectInsideRepository : '.';

  const output = executeGit(['status', '--porcelain', '--', target], gitRepositoryRoot);

  return output.trim().length > 0;
}

/**
 * ============================================================
 * FILE DISCOVERY
 * ============================================================
 */

function isTypeScriptFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');

  /**
   * We currently do not treat declaration files as
   * application entities.
   */
  if (normalized.endsWith('.d.ts') || normalized.endsWith('.d.mts') || normalized.endsWith('.d.cts')) {
    return false;
  }

  return TYPESCRIPT_EXTENSIONS.has(path.extname(filePath));
}

function collectTypeScriptFiles(directory: string): string[] {
  const results: string[] = [];

  const entries = fs.readdirSync(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      results.push(...collectTypeScriptFiles(absolutePath));

      continue;
    }

    if (entry.isFile() && isTypeScriptFile(absolutePath)) {
      results.push(absolutePath);
    }
  }

  return results;
}

/**
 * ============================================================
 * PATH HELPERS
 * ============================================================
 */

function normalizeProjectPath(fileName: string): string {
  return path.relative(projectRoot, fileName).replace(/\\/g, '/');
}

/**
 * Git reports paths relative to repository root.
 *
 * Graphentra entities are relative to projectRoot.
 *
 * Currently both are identical because demo-application
 * itself is the repository.
 */

function gitPathToProjectPath(gitFile: string): string {
  const normalized = gitFile.replace(/\\/g, '/');

  if (projectInsideRepository && projectInsideRepository !== '.' && normalized.startsWith(`${projectInsideRepository}/`)) {
    return normalized.slice(projectInsideRepository.length + 1);
  }

  return normalized;
}

/**
 * ============================================================
 * DISCOVER TYPESCRIPT FILES
 * ============================================================
 */

const files = collectTypeScriptFiles(projectRoot).sort();

if (files.length === 0) {
  console.log('\nNo TypeScript files found.');

  process.exit(0);
}

/**
 * ============================================================
 * TYPESCRIPT PROGRAM
 * ============================================================
 *
 * If the target repository has tsconfig.json, we reuse its
 * compiler options.
 *
 * Otherwise use safe defaults for the current prototype.
 */

function getCompilerOptions(): ts.CompilerOptions {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);

    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));

      return {
        ...parsed.options,

        noEmit: true,

        skipLibCheck: true,
      };
    }
  }

  /**
   * demo-application currently has no tsconfig.
   *
   * These defaults are suitable for analyzing source files
   * without emitting JavaScript.
   */

  return {
    target: ts.ScriptTarget.ES2022,

    module: ts.ModuleKind.Preserve,

    moduleResolution: ts.ModuleResolutionKind.Bundler,

    jsx: ts.JsxEmit.ReactJSX,

    noEmit: true,

    skipLibCheck: true,

    allowJs: false,
  };
}

const program = ts.createProgram(files, getCompilerOptions());

const checker = program.getTypeChecker();

/**
 * Ensure we only analyze source files explicitly discovered
 * inside the customer's project.
 *
 * TypeScript Program also contains lib.d.ts and dependencies.
 */

const analyzedFileSet = new Set(files.map(file => path.resolve(file)));

/**
 * ============================================================
 * GRAPH STORAGE
 * ============================================================
 */

const entities: Entity[] = [];

const relations: Relation[] = [];

const entityById = new Map<string, Entity>();

const symbolToEntity = new Map<ts.Symbol, Entity>();

const relationKeys = new Set<string>();

/**
 * ============================================================
 * SYMBOL HELPERS
 * ============================================================
 */

function resolveSymbol(node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);

  if (!symbol) {
    return undefined;
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  return symbol;
}

function addRelation(relation: Relation): void {
  const key = `${relation.from}|${relation.type}|${relation.to}`;

  if (relationKeys.has(key)) {
    return;
  }

  relationKeys.add(key);

  relations.push(relation);
}

function getEntity(id: string): Entity | undefined {
  return entityById.get(id);
}

/**
 * ============================================================
 * PASS 1
 *
 * DISCOVER FUNCTION ENTITIES
 * ============================================================
 *
 * Current MVP supports:
 *
 * function calculatePrice() {}
 *
 * It does NOT yet support:
 *
 * const calculatePrice = () => {}
 * class.method()
 * object.method()
 */

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) {
    continue;
  }

  const absoluteFile = path.resolve(sourceFile.fileName);

  if (!analyzedFileSet.has(absoluteFile)) {
    continue;
  }

  const relativeFile = normalizeProjectPath(sourceFile.fileName);

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

      const entity: Entity = {
        id: `${relativeFile}#${node.name.text}`,

        kind: 'function',

        name: node.name.text,

        file: relativeFile,

        startLine: start.line + 1,

        endLine: end.line + 1,
      };

      entities.push(entity);

      entityById.set(entity.id, entity);

      const symbol = resolveSymbol(node.name);

      if (symbol) {
        symbolToEntity.set(symbol, entity);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * ============================================================
 * FIND ENCLOSING FUNCTION
 * ============================================================
 */

function findEnclosingFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

/**
 * ============================================================
 * PASS 2
 *
 * DISCOVER CALL RELATIONSHIPS
 * ============================================================
 */

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) {
    continue;
  }

  const absoluteFile = path.resolve(sourceFile.fileName);

  if (!analyzedFileSet.has(absoluteFile)) {
    continue;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calledSymbol = resolveSymbol(node.expression);

      if (calledSymbol) {
        const callerFunction = findEnclosingFunction(node);

        if (callerFunction?.name) {
          const callerSymbol = resolveSymbol(callerFunction.name);

          if (callerSymbol) {
            const callerEntity = symbolToEntity.get(callerSymbol);

            const calledEntity = symbolToEntity.get(calledSymbol);

            if (callerEntity && calledEntity) {
              addRelation({
                from: callerEntity.id,

                to: calledEntity.id,

                type: 'CALLS',
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * ============================================================
 * BUILD ADJACENCY MAPS
 * ============================================================
 */

const adjacency = new Map<string, Relation[]>();

const reverseAdjacency = new Map<string, Relation[]>();

for (const entity of entities) {
  adjacency.set(entity.id, []);

  reverseAdjacency.set(entity.id, []);
}

for (const relation of relations) {
  adjacency.get(relation.from)?.push(relation);

  reverseAdjacency.get(relation.to)?.push(relation);
}

/**
 * ============================================================
 * GIT DIFF RANGE
 * ============================================================
 *
 * Current GitHub workflow checks out:
 *
 * fetch-depth: 2
 *
 * Therefore Graphentra can compare:
 *
 * HEAD~1
 * HEAD
 *
 * Later we can provide BASE_SHA and HEAD_SHA explicitly for
 * pull requests / multi-commit pushes.
 */

function getDiffRange(): {
  base: string;
  head: string;
} {
  const baseFromEnvironment = process.env.BASE_SHA?.trim();

  const headFromEnvironment = process.env.HEAD_SHA?.trim();

  if (baseFromEnvironment && headFromEnvironment && !/^0+$/.test(baseFromEnvironment)) {
    return {
      base: baseFromEnvironment,

      head: headFromEnvironment,
    };
  }

  return {
    base: 'HEAD~1',

    head: 'HEAD',
  };
}

/**
 * ============================================================
 * GET RAW GIT DIFF
 * ============================================================
 */

function getGitDiff(): string {
  const { base, head } = getDiffRange();

  const target = projectInsideRepository && projectInsideRepository !== '.' ? projectInsideRepository : '.';

  try {
    return executeGit(
      ['diff', '--unified=3', base, head, '--', target],

      gitRepositoryRoot,
    );
  } catch (error) {
    console.error(`\n❌ Could not compare ${base} → ${head}.`);

    console.error('Make sure enough Git history was checked out.\n');

    throw error;
  }
}

/**
 * ============================================================
 * PARSE GIT DIFF
 * ============================================================
 *
 * Converts raw Git:
 *
 * - return price + tax;
 * + return price + tax + 2;
 *
 * into:
 *
 * {
 *   file: "pricing.ts",
 *   changedLines: [3],
 *   removedCode: [...],
 *   addedCode: [...]
 * }
 */

function parseGitDiff(diff: string): ChangedFile[] {
  const changedFiles = new Map<
    string,
    {
      changedLines: Set<number>;

      addedCode: string[];

      removedCode: string[];

      diffLines: string[];
    }
  >();

  let currentFile: string | undefined;

  let currentInformation:
    | {
        changedLines: Set<number>;

        addedCode: string[];

        removedCode: string[];

        diffLines: string[];
      }
    | undefined;

  let newLineNumber = 0;

  let insideHunk = false;

  let pendingHeaderLines: string[] = [];

  let oldFile: string | undefined;

  for (const line of diff.split('\n')) {
    /**
     * Start new file diff.
     */

    if (line.startsWith('diff --git ')) {
      currentFile = undefined;

      currentInformation = undefined;

      insideHunk = false;

      oldFile = undefined;

      pendingHeaderLines = [line];

      continue;
    }

    /**
     * Keep Git metadata before +++.
     */

    if (!currentInformation) {
      pendingHeaderLines.push(line);
    }

    /**
     * Old file path.
     */

    if (line.startsWith('--- a/')) {
      oldFile = gitPathToProjectPath(line.slice('--- a/'.length));

      continue;
    }

    /**
     * Deleted file.
     *
     * Deleted functions cannot be mapped against the new AST
     * yet, but we still preserve the diff evidence.
     */

    if (line === '+++ /dev/null') {
      if (!oldFile) {
        continue;
      }

      currentFile = oldFile;

      currentInformation = changedFiles.get(currentFile);

      if (!currentInformation) {
        currentInformation = {
          changedLines: new Set<number>(),

          addedCode: [],

          removedCode: [],

          diffLines: [],
        };

        changedFiles.set(currentFile, currentInformation);
      }

      currentInformation.diffLines.push(...pendingHeaderLines);

      pendingHeaderLines = [];

      continue;
    }

    /**
     * New/current file path.
     */

    if (line.startsWith('+++ b/')) {
      const gitFile = line.slice('+++ b/'.length);

      currentFile = gitPathToProjectPath(gitFile);

      currentInformation = changedFiles.get(currentFile);

      if (!currentInformation) {
        currentInformation = {
          changedLines: new Set<number>(),

          addedCode: [],

          removedCode: [],

          diffLines: [],
        };

        changedFiles.set(currentFile, currentInformation);
      }

      currentInformation.diffLines.push(...pendingHeaderLines);

      pendingHeaderLines = [];

      continue;
    }

    if (!currentFile || !currentInformation) {
      continue;
    }

    currentInformation.diffLines.push(line);

    /**
     * Example:
     *
     * @@ -1,4 +1,4 @@
     */

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

    if (hunkMatch) {
      insideHunk = true;

      newLineNumber = Number(hunkMatch[1]);

      continue;
    }

    if (!insideHunk) {
      continue;
    }

    /**
     * Added line.
     */

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentInformation.changedLines.add(Math.max(newLineNumber, 1));

      currentInformation.addedCode.push(line.slice(1));

      newLineNumber += 1;

      continue;
    }

    /**
     * Removed line.
     *
     * A removed line does not exist in the new file anymore.
     * We anchor the change to the nearest new-file position.
     */

    if (line.startsWith('-') && !line.startsWith('---')) {
      currentInformation.changedLines.add(Math.max(newLineNumber, 1));

      currentInformation.removedCode.push(line.slice(1));

      continue;
    }

    /**
     * Context line exists in both versions.
     */

    if (line.startsWith(' ')) {
      newLineNumber += 1;
    }
  }

  return [...changedFiles.entries()]
    .map(([file, information]) => ({
      file,

      changedLines: [...information.changedLines].sort((a, b) => a - b),

      addedCode: information.addedCode,

      removedCode: information.removedCode,

      diff: information.diffLines.join('\n').trim(),
    }))
    .filter(change => isTypeScriptFile(change.file));
}

/**
 * ============================================================
 * MAP CHANGED LINES → FUNCTIONS
 * ============================================================
 */

function findChangedEntities(changedFiles: ChangedFile[]): ChangedEntity[] {
  const results: ChangedEntity[] = [];

  for (const changedFile of changedFiles) {
    const fileEntities = entities.filter(entity => entity.file === changedFile.file);

    for (const entity of fileEntities) {
      const overlaps = changedFile.changedLines.some(line => line >= entity.startLine && line <= entity.endLine);

      if (!overlaps) {
        continue;
      }

      results.push({
        entity,

        change: changedFile,
      });
    }
  }

  return results;
}

/**
 * ============================================================
 * GRAPH QUERIES
 * ============================================================
 */

function getCallers(entityId: string): Entity[] {
  const incoming = reverseAdjacency.get(entityId) ?? [];

  const result = new Map<string, Entity>();

  for (const relation of incoming) {
    const caller = getEntity(relation.from);

    if (caller) {
      result.set(caller.id, caller);
    }
  }

  return [...result.values()];
}

/**
 * ============================================================
 * BLAST RADIUS
 * ============================================================
 */

function getBlastRadiusPaths(entityId: string): ImpactPath[] {
  const start = getEntity(entityId);

  if (!start) {
    return [];
  }

  const results: ImpactPath[] = [];

  const queue: Array<{
    entity: Entity;

    path: Entity[];

    visitedInPath: Set<string>;
  }> = [
    {
      entity: start,

      path: [start],

      visitedInPath: new Set([start.id]),
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    const currentDepth = current.path.length - 1;

    if (currentDepth >= MAX_BLAST_DEPTH) {
      continue;
    }

    const callers = getCallers(current.entity.id);

    for (const caller of callers) {
      /**
       * Prevent cycles on this dependency path.
       */

      if (current.visitedInPath.has(caller.id)) {
        continue;
      }

      const newPath = [...current.path, caller];

      results.push({
        target: caller,

        depth: newPath.length - 1,

        path: newPath,
      });

      const nextVisited = new Set(current.visitedInPath);

      nextVisited.add(caller.id);

      queue.push({
        entity: caller,

        path: newPath,

        visitedInPath: nextVisited,
      });
    }
  }

  return results;
}

/**
 * ============================================================
 * TERMINAL DEPENDENTS
 * ============================================================
 */

function getTerminalDependents(impactedEntities: Entity[]): Entity[] {
  return impactedEntities.filter(entity => getCallers(entity.id).length === 0);
}

/**
 * ============================================================
 * BUILD IMPACT
 * ============================================================
 */

function buildImpact(changedEntity: ChangedEntity): EntityImpact {
  const paths = getBlastRadiusPaths(changedEntity.entity.id);

  const affected = new Map<string, Entity>();

  const direct = new Map<string, Entity>();

  for (const impact of paths) {
    affected.set(impact.target.id, impact.target);

    if (impact.depth === 1) {
      direct.set(impact.target.id, impact.target);
    }
  }

  const affectedEntities = [...affected.values()];

  return {
    changedEntity: changedEntity.entity,

    change: changedEntity.change,

    directDependents: [...direct.values()],

    blastRadius: {
      totalAffectedEntities: affectedEntities.length,

      entities: affectedEntities,

      paths,
    },

    terminalDependents: getTerminalDependents(affectedEntities),
  };
}

/**
 * ============================================================
 * TECHNICAL GRAPH
 * ============================================================
 */

function buildTechnicalGraph(): TechnicalGraph {
  return {
    schemaVersion: '1.0',

    repository: {
      root: projectRoot,

      headSha: getHeadSha(),

      workingTreeDirty: isWorkingTreeDirty(),

      generatedAt: new Date().toISOString(),

      analyzerVersion: ANALYZER_VERSION,
    },

    capabilities: {
      language: 'typescript',

      entityKinds: ['function'],

      relationTypes: ['CALLS'],

      maxBlastDepth: MAX_BLAST_DEPTH,
    },

    analyzedFiles: files.map(normalizeProjectPath),

    entities: [...entities].sort((a, b) => a.id.localeCompare(b.id)),

    relations: [...relations].sort((a, b) => {
      const from = a.from.localeCompare(b.from);

      if (from !== 0) {
        return from;
      }

      return a.to.localeCompare(b.to);
    }),
  };
}

/**
 * ============================================================
 * OUTPUT FILES
 * ============================================================
 *
 * Store Graphentra's generated information in the analyzer
 * workspace rather than modifying the customer's repository.
 */

function writeOutputFile(name: string, data: unknown): string {
  const directory = path.resolve(process.cwd(), '.graphentra-output');

  fs.mkdirSync(directory, {
    recursive: true,
  });

  const outputFile = path.join(directory, name);

  fs.writeFileSync(
    outputFile,

    JSON.stringify(data, null, 2),

    'utf8',
  );

  return outputFile;
}

/**
 * ============================================================
 * CONSOLE REPORT
 * ============================================================
 */

function printChangedFile(change: ChangedFile): void {
  console.log('\n----------------------------------------');

  console.log(`📄 ${change.file}`);

  console.log('----------------------------------------');

  console.log(`Changed lines: ${change.changedLines.length ? change.changedLines.join(', ') : 'unknown'}`);

  if (change.removedCode.length) {
    console.log('\nRemoved:');

    for (const line of change.removedCode) {
      console.log(`- ${line}`);
    }
  }

  if (change.addedCode.length) {
    console.log('\nAdded:');

    for (const line of change.addedCode) {
      console.log(`+ ${line}`);
    }
  }

  console.log('\nRaw Git diff:\n');

  console.log(change.diff);
}

function printImpact(impact: EntityImpact): void {
  console.log('\n========================================');

  console.log(`💥 IMPACT — ${impact.changedEntity.name}`);

  console.log('========================================');

  console.log(`Entity: ${impact.changedEntity.id}`);

  console.log(`Lines: ${impact.changedEntity.startLine}-${impact.changedEntity.endLine}`);

  console.log('\nDirect dependents:');

  if (impact.directDependents.length === 0) {
    console.log('  none');
  } else {
    for (const entity of impact.directDependents) {
      console.log(`  → ${entity.id}`);
    }
  }

  console.log(`\nBlast radius: ${impact.blastRadius.totalAffectedEntities} entities`);

  if (impact.blastRadius.paths.length) {
    console.log('\nImpact paths:');

    for (const impactPath of impact.blastRadius.paths) {
      console.log(`  ${impactPath.path.map(entity => entity.name).join(' → ')}`);
    }
  }

  console.log('\nTerminal dependents:');

  if (impact.terminalDependents.length === 0) {
    console.log('  none');
  } else {
    for (const terminal of impact.terminalDependents) {
      console.log(`  → ${terminal.id}`);
    }
  }
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

function run(): void {
  console.log('\n========================================');

  console.log('🔍 GRAPHENTRA ANALYZER');

  console.log('========================================');

  console.log(`📁 Target: ${projectRoot}`);

  console.log(`📘 TypeScript files: ${files.length}`);

  console.log(`🔵 Functions discovered: ${entities.length}`);

  console.log(`🔗 CALLS relations: ${relations.length}`);

  /**
   * --------------------------------------
   * Write full repository graph.
   * --------------------------------------
   */

  const technicalGraph = buildTechnicalGraph();

  const technicalGraphFile = writeOutputFile(
    'technical-graph.json',

    technicalGraph,
  );

  /**
   * --------------------------------------
   * Git changes
   * --------------------------------------
   */

  const gitDiff = getGitDiff();

  if (!gitDiff.trim()) {
    console.log('\nNo Git changes found.');

    console.log(`\nTechnical graph: ${technicalGraphFile}\n`);

    return;
  }

  const changedFiles = parseGitDiff(gitDiff);

  console.log(`\n📝 Changed TypeScript files: ${changedFiles.length}`);

  for (const change of changedFiles) {
    printChangedFile(change);
  }

  /**
   * --------------------------------------
   * Changed functions
   * --------------------------------------
   */

  const changedEntities = findChangedEntities(changedFiles);

  console.log(`\n🎯 Changed functions: ${changedEntities.length}`);

  if (changedEntities.length === 0) {
    console.log('\nGit changes were found, but no supported named function declaration matched the changed lines.');
  }

  for (const changedEntity of changedEntities) {
    console.log(`  → ${changedEntity.entity.id}`);
  }

  /**
   * --------------------------------------
   * Blast radius
   * --------------------------------------
   */

  const impacts = changedEntities.map(buildImpact);

  for (const impact of impacts) {
    printImpact(impact);
  }

  /**
   * --------------------------------------
   * Final machine-readable evidence.
   * --------------------------------------
   */

  const analysis: AnalysisResult = {
    schemaVersion: '1.0',

    repository: {
      root: projectRoot,

      headSha: getHeadSha(),
    },

    analyzedFiles: files.map(normalizeProjectPath),

    changedFiles,

    changedEntities,

    impacts,

    limitations: [
      'Only TypeScript is analyzed.',

      'Only named function declarations are currently entities.',

      'Only CALLS relationships are currently modeled.',

      'Arrow functions and class methods are not yet modeled.',

      'Blast-radius traversal is limited to depth 6.',

      'Deleted functions cannot yet be mapped because only the post-change AST is analyzed.',

      'Top-level module execution is not currently represented as an entity.',

      'Dynamic runtime calls are not resolved.',
    ],
  };

  const analysisFile = writeOutputFile(
    'analysis.json',

    analysis,
  );

  console.log('\n========================================');

  console.log('✅ GRAPHENTRA ANALYSIS COMPLETE');

  console.log('========================================');

  console.log(`Technical graph: ${technicalGraphFile}`);

  console.log(`Analysis: ${analysisFile}`);

  console.log();
}

try {
  run();
} catch (error) {
  console.error('\n❌ Graphentra analysis failed.');

  console.error(error);

  process.exitCode = 1;
}
