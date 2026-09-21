import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { GraphentraError } from './errors';
import {
  ANALYZER_VERSION,
  IGNORED_DIRECTORIES,
  MAX_BLAST_DEPTH,
  TYPESCRIPT_EXTENSIONS,
  type Entity,
  type Relation,
  type TechnicalGraph,
} from './contracts';

export function isTypeScriptFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (
    normalized.endsWith('.d.ts') ||
    normalized.endsWith('.d.mts') ||
    normalized.endsWith('.d.cts')
  ) {
    return false;
  }
  return TYPESCRIPT_EXTENSIONS.has(path.extname(filePath));
}

export function collectTypeScriptFiles(
  directory: string,
  projectRoot: string,
  options?: { excludePaths?: string[] },
): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(directory, {
    withFileTypes: true,
  });

  const resolvedExcludes = (options?.excludePaths ?? [])
    .map(p => path.resolve(projectRoot, p));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (resolvedExcludes.some(exclude => absolutePath === exclude || absolutePath.startsWith(`${exclude}/`))) continue;
    if (entry.isDirectory()) {

      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      results.push(...collectTypeScriptFiles(absolutePath, projectRoot, options));
      continue;
    }

    if (entry.isFile() && isTypeScriptFile(absolutePath)) {
      results.push(absolutePath);
    }
  }

  return results;
}

export function getCompilerOptions(projectRoot: string): ts.CompilerOptions {
  const configPath = fs.existsSync(path.join(projectRoot, 'tsconfig.json')) ? path.join(projectRoot, 'tsconfig.json') : undefined;

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
      );
      return {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
      };
    }
  }

  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    skipLibCheck: true,
  };
}

function findEnclosingFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

export interface ExtractedGraph {
  technicalGraph: TechnicalGraph;
  entities: Entity[];
  relations: Relation[];
  entityById: Map<string, Entity>;
  reverseAdjacency: Map<string, Relation[]>;
  files: string[];
}

export function extractTechnicalGraph(options: {
  projectRoot: string;
  headSha: string;
  targetPath?: string;
  files?: string[];
  compilerOptions?: ts.CompilerOptions;
  host?: ts.CompilerHost;
  excludePaths?: string[];
}): ExtractedGraph {
  const { projectRoot, headSha, targetPath = '.', excludePaths } = options;
  const files = options.files ?? collectTypeScriptFiles(projectRoot, projectRoot, { excludePaths }).sort();

  const originalFiles = new Map(files.map(file => [path.resolve(file).replace(/\\/g, '/'), file]));
  const normalizeProjectPath = (filePath: string): string =>
    path.relative(projectRoot, originalFiles.get(path.resolve(filePath).replace(/\\/g, '/')) ?? filePath).split(path.sep).join('/');

  if (files.length === 0) {
    const emptyGraph: TechnicalGraph = {
      schemaVersion: '1.0',
      repository: {
        targetPath,
        headSha,
        generatedAt: new Date().toISOString(),
        analyzerVersion: ANALYZER_VERSION,
      },
      capabilities: {
        language: 'typescript',
        entityKinds: ['function'],
        relationTypes: ['CALLS'],
        maxBlastDepth: MAX_BLAST_DEPTH,
      },
      analyzedFiles: [],
      entities: [],
      relations: [],
    };
    return {
      technicalGraph: emptyGraph,
      entities: [],
      relations: [],
      entityById: new Map(),
      reverseAdjacency: new Map(),
      files: [],
    };
  }

  const program = ts.createProgram(files, options.compilerOptions ?? getCompilerOptions(projectRoot), options.host);
  const checker = program.getTypeChecker();
  const analyzedFileSet = new Set(files.map(file => path.resolve(file).replace(/\\/g, '/')));

  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const entityById = new Map<string, Entity>();
  const symbolToEntity = new Map<ts.Symbol, Entity>();
  const relationKeys = new Set<string>();

  function resolveSymbol(node: ts.Node): ts.Symbol | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  function addRelation(relation: Relation): void {
    const key = `${relation.from}|${relation.type}|${relation.to}`;
    if (relationKeys.has(key)) return;
    relationKeys.add(key);
    relations.push(relation);
  }

  // Pass 1 - functions
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!analyzedFileSet.has(path.resolve(sourceFile.fileName).replace(/\\/g, '/'))) continue;

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

        if (entityById.has(entity.id)) throw new GraphentraError('Duplicate function identity in source.', 'AMBIGUOUS_ENTITY_ID');
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

  // Pass 2 - call relationships
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!analyzedFileSet.has(path.resolve(sourceFile.fileName).replace(/\\/g, '/'))) continue;

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const calledSymbol = resolveSymbol(node.expression);
        const callerFunction = findEnclosingFunction(node);

        if (calledSymbol && callerFunction?.name) {
          const callerSymbol = resolveSymbol(callerFunction.name);
          if (callerSymbol) {
            const caller = symbolToEntity.get(callerSymbol);
            const called = symbolToEntity.get(calledSymbol);

            if (caller && called) {
              addRelation({
                from: caller.id,
                to: called.id,
                type: 'CALLS',
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Reverse graph
  const reverseAdjacency = new Map<string, Relation[]>();
  for (const entity of entities) {
    reverseAdjacency.set(entity.id, []);
  }
  for (const relation of relations) {
    reverseAdjacency.get(relation.to)?.push(relation);
  }

  const technicalGraph: TechnicalGraph = {
    schemaVersion: '1.0',
    repository: {
      targetPath,
      headSha,
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
    entities: [...entities],
    relations: [...relations],
  };

  return {
    technicalGraph,
    entities,
    relations,
    entityById,
    reverseAdjacency,
    files,
  };
}
