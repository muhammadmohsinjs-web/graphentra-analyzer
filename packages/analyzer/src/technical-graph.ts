import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { collectEntities } from './entity-collector';
import { GraphentraError } from './errors';
import {
  ANALYZER_VERSION,
  DEFAULT_ENGINE,
  EXTENDED_ENTITY_KINDS,
  EXTENDED_RELATION_TYPES,
  IGNORED_DIRECTORIES,
  JAVASCRIPT_EXTENSIONS,
  LEGACY_ENTITY_KINDS,
  LEGACY_RELATION_TYPES,
  MAX_BLAST_DEPTH,
  TYPESCRIPT_EXTENSIONS,
  type DiagnosticItem,
  type Entity,
  type EngineProfile,
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

/** Engine-aware file selection: legacy is TypeScript only; extended also analyzes JavaScript. */
export function isAnalyzableFile(filePath: string, engine: EngineProfile = DEFAULT_ENGINE): boolean {
  if (isTypeScriptFile(filePath)) return true;
  if (engine !== 'extended') return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith('.min.js')) return false;
  if (normalized.split('/').some(part => IGNORED_DIRECTORIES.has(part))) return false;
  return JAVASCRIPT_EXTENSIONS.has(path.extname(filePath));
}

export function collectTypeScriptFiles(
  directory: string,
  projectRoot: string,
  options?: { excludePaths?: string[]; engine?: EngineProfile },
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

    if (entry.isFile() && isAnalyzableFile(absolutePath, options?.engine)) {
      results.push(absolutePath);
    }
  }

  return results;
}

export function getCompilerOptions(projectRoot: string, engine: EngineProfile = DEFAULT_ENGINE): ts.CompilerOptions {
  const extendedOptions = (options: ts.CompilerOptions): ts.CompilerOptions =>
    engine === 'extended' ? { ...options, allowJs: true, checkJs: options.checkJs ?? false } : options;
  const configPath = fs.existsSync(path.join(projectRoot, 'tsconfig.json')) ? path.join(projectRoot, 'tsconfig.json')
    : engine === 'extended' && fs.existsSync(path.join(projectRoot, 'jsconfig.json')) ? path.join(projectRoot, 'jsconfig.json')
    : undefined;

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
      );
      return {
        ...extendedOptions(parsed.options),
        noEmit: true,
        skipLibCheck: true,
      };
    }
  }

  return {
    ...(engine === 'extended' ? { allowJs: true, checkJs: false } : {}),
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
  /** Extended engine only (always empty for legacy). */
  diagnostics: DiagnosticItem[];
  /** Extended engine only (empty for legacy): entity id to enclosing entity id (undefined for module entities). */
  parentById: Map<string, string | undefined>;
  entityById: Map<string, Entity>;
  reverseAdjacency: Map<string, Relation[]>;
  files: string[];
  /** Compiler state shared with derived deterministic extractors (application map). */
  program?: ts.Program;
  checker?: ts.TypeChecker;
  symbolToEntity?: Map<ts.Symbol, Entity>;
  toProjectPath?: (fileName: string) => string;
}

export function extractTechnicalGraph(options: {
  projectRoot: string;
  headSha: string;
  targetPath?: string;
  files?: string[];
  compilerOptions?: ts.CompilerOptions;
  host?: ts.CompilerHost;
  excludePaths?: string[];
  engine?: EngineProfile;
}): ExtractedGraph {
  const { projectRoot, headSha, targetPath = '.', excludePaths } = options;
  const files = options.files ?? collectTypeScriptFiles(projectRoot, projectRoot, { excludePaths, engine: options.engine }).sort();

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
        entityKinds: [...((options.engine ?? DEFAULT_ENGINE) === 'extended' ? EXTENDED_ENTITY_KINDS : LEGACY_ENTITY_KINDS)],
        relationTypes: [...((options.engine ?? DEFAULT_ENGINE) === 'extended' ? EXTENDED_RELATION_TYPES : LEGACY_RELATION_TYPES)],
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
      diagnostics: [],
      parentById: new Map(),
      entityById: new Map(),
      reverseAdjacency: new Map(),
      files: [],
    };
  }

  const program = ts.createProgram(files, options.compilerOptions ?? getCompilerOptions(projectRoot, options.engine), options.host);
  const checker = program.getTypeChecker();
  const analyzedFileSet = new Set(files.map(file => path.resolve(file).replace(/\\/g, '/')));

  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const diagnostics: DiagnosticItem[] = [];
  const parentById = new Map<string, string | undefined>();
  const declarationToEntity = new Map<ts.Node, Entity>();
  const extendedEngine = (options.engine ?? DEFAULT_ENGINE) === 'extended';
  const entityById = new Map<string, Entity>();
  const symbolToEntity = new Map<ts.Symbol, Entity>();
  const relationKeys = new Set<string>();
  const failedFiles = new Set<string>();
  const errorClassName = (error: unknown): string => error instanceof Error ? error.constructor.name : typeof error;

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

    if (extendedEngine) {
      const syntaxErrors = program.getSyntacticDiagnostics(sourceFile).length;
      if (syntaxErrors > 0) {
        diagnostics.push({
          code: 'FILE_PARSE_ERRORS',
          severity: 'warning',
          file: relativeFile,
          message: `${syntaxErrors} syntax error(s); entities were collected from the parts that parse.`,
        });
      }
    }

    // Extended: a failing file is rolled back and skipped; legacy keeps today's behavior (errors propagate).
    const registered: Entity[] = [];
    const registeredDiagnostics = diagnostics.length;
    try {
      for (const candidate of collectEntities(sourceFile, { relativeFile, engine: options.engine ?? DEFAULT_ENGINE })) {
        const entity = candidate.entity;
        if (entityById.has(entity.id)) throw new GraphentraError('Duplicate function identity in source.', 'AMBIGUOUS_ENTITY_ID');
        entities.push(entity);
        entityById.set(entity.id, entity);
        registered.push(entity);
        if (extendedEngine) {
          parentById.set(entity.id, candidate.parent?.entity.id);
          declarationToEntity.set(candidate.declarationNode, entity);
        }
        if (candidate.disambiguatedFrom !== undefined) {
          diagnostics.push({
            code: 'DUPLICATE_ENTITY_ID_DISAMBIGUATED',
            severity: 'info',
            message: `Entity ID ${candidate.disambiguatedFrom} is declared more than once; this declaration was assigned ${entity.id}.`,
            file: entity.file,
            entityId: entity.id,
          });
        }

        for (const symbolNode of candidate.symbolNodes) {
          const symbol = resolveSymbol(symbolNode);
          if (symbol) {
            symbolToEntity.set(symbol, entity);
          }
        }
        if (candidate.exportDefault) {
          let defaultSymbol = checker.getSymbolAtLocation(sourceFile)?.exports?.get('default' as ts.__String);
          if (defaultSymbol && defaultSymbol.flags & ts.SymbolFlags.Alias) defaultSymbol = checker.getAliasedSymbol(defaultSymbol);
          if (defaultSymbol) symbolToEntity.set(defaultSymbol, entity);
        }
      }
    } catch (error) {
      if (!extendedEngine) throw error;
      const registeredIds = new Set(registered.map(entity => entity.id));
      for (let index = entities.length - 1; index >= 0 && registeredIds.size > 0; index--) {
        if (registeredIds.delete(entities[index].id)) entities.splice(index, 1);
      }
      for (const entity of registered) {
        entityById.delete(entity.id);
        parentById.delete(entity.id);
      }
      for (const [node, entity] of declarationToEntity) if (entity.file === relativeFile) declarationToEntity.delete(node);
      for (const [symbol, entity] of symbolToEntity) if (entity.file === relativeFile) symbolToEntity.delete(symbol);
      diagnostics.length = registeredDiagnostics;
      failedFiles.add(sourceFile.fileName);
      diagnostics.push({
        code: 'FILE_ANALYSIS_FAILED',
        severity: 'warning',
        file: relativeFile,
        message: `Entity collection failed (${errorClassName(error)}); the file was skipped.`,
      });
    }
  }

  // Pass 2 - call and instantiation relationships
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!analyzedFileSet.has(path.resolve(sourceFile.fileName).replace(/\\/g, '/'))) continue;
    if (failedFiles.has(sourceFile.fileName)) continue;

    // Relations are buffered per file and added all or nothing under the extended engine.
    const fileRelations: Relation[] = [];
    const emit = (relation: Relation): void => {
      if (extendedEngine) fileRelations.push(relation);
      else addRelation(relation);
    };

    // Innermost enclosing entity; the source file node maps to the module entity.
    function enclosingEntity(node: ts.Node): Entity | undefined {
      let enclosing: ts.Node | undefined = node.parent;
      let entity: Entity | undefined;
      while (enclosing && !(entity = declarationToEntity.get(enclosing))) enclosing = enclosing.parent;
      return entity;
    }

    function entityOfSymbol(symbol: ts.Symbol | undefined): Entity | undefined {
      if (!symbol) return undefined;
      const declaration = symbol.declarations?.length === 1 ? symbol.declarations[0] : undefined;
      return symbolToEntity.get(symbol) ?? (declaration ? declarationToEntity.get(declaration) : undefined);
    }

    // The node whose symbol a function value comes from: `handle`, `this.handle`, `obj.handle`.
    function valueSymbol(node: ts.Expression): ts.Symbol | undefined {
      if (ts.isIdentifier(node)) return resolveSymbol(node);
      if (ts.isPropertyAccessExpression(node)) return resolveSymbol(node.name);
      return undefined;
    }

    // A getter read is an implicit call and a `useMemo` binding holds a computed value; neither is a function value.
    function isFunctionValue(symbol: ts.Symbol | undefined): boolean {
      const declaration = symbol?.declarations?.[0];
      if (!declaration) return false;
      if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) return false;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
        const callee = declaration.initializer.expression;
        if (ts.isIdentifier(callee) && callee.text === 'useMemo') return false;
      }
      return true;
    }

    // True when the expression is stored or passed on as a value rather than called here.
    function isValuePosition(node: ts.Expression): boolean {
      let child: ts.Node = node;
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) {
        child = parent;
        parent = parent.parent;
      }
      if (ts.isJsxExpression(parent)) return true;
      if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.arguments?.includes(child as ts.Expression) ?? false;
      if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) return parent.initializer === child;
      if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === child;
      return ts.isReturnStatement(parent);
    }

    function visit(node: ts.Node): void {
      if (extendedEngine) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          // Lowercase tags are intrinsic elements (`div`), not symbols.
          const tag = node.tagName;
          if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text))) {
            const caller = enclosingEntity(node);
            const rendered = entityOfSymbol(ts.isPropertyAccessExpression(tag) ? resolveSymbol(tag.name) : resolveSymbol(tag));
            if (caller && rendered && caller.id !== rendered.id) emit({ from: caller.id, to: rendered.id, type: 'RENDERS' });
          }
        } else if (ts.isShorthandPropertyAssignment(node)) {
          const caller = enclosingEntity(node);
          const valueSym = checker.getShorthandAssignmentValueSymbol(node);
          const referenced = isFunctionValue(valueSym) ? entityOfSymbol(valueSym) : undefined;
          if (caller && referenced && caller.id !== referenced.id) emit({ from: caller.id, to: referenced.id, type: 'REFERENCES' });
        } else if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && isValuePosition(node)) {
          const caller = enclosingEntity(node);
          const valueSym = valueSymbol(node);
          const referenced = isFunctionValue(valueSym) ? entityOfSymbol(valueSym) : undefined;
          if (caller && referenced && caller.id !== referenced.id) emit({ from: caller.id, to: referenced.id, type: 'REFERENCES' });
        }
      }
      if (ts.isNewExpression(node) && extendedEngine) {
        // The resolved signature names the constructor that runs, including an inherited one
        // (or the function, for a JavaScript constructor function).
        // Overloads resolve to a bodiless declaration, so fall back to the implementation.
        // A class with no constructor anywhere in its chain has no entity to target and gets no edge.
        let declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && ts.isConstructorDeclaration(declaration) && !declaration.body) {
          declaration = declaration.parent.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && !!member.body);
        }
        const caller = enclosingEntity(node);
        const constructed = declaration ? declarationToEntity.get(declaration) : undefined;
        if (caller && constructed) emit({ from: caller.id, to: constructed.id, type: 'INSTANTIATES' });
      } else if (ts.isCallExpression(node) && extendedEngine) {
        const caller = enclosingEntity(node);
        const calledSymbol = resolveSymbol(node.expression);
        // Widened object-literal types hand back cloned property symbols, so fall back to the single declaration node.
        const calledDeclaration = calledSymbol?.declarations?.length === 1 ? calledSymbol.declarations[0] : undefined;
        const called = calledSymbol
          ? symbolToEntity.get(calledSymbol) ?? (calledDeclaration ? declarationToEntity.get(calledDeclaration) : undefined)
          : undefined;
        if (caller && called) emit({ from: caller.id, to: called.id, type: 'CALLS' });
      } else if (ts.isCallExpression(node)) {
        const calledSymbol = resolveSymbol(node.expression);
        const callerFunction = findEnclosingFunction(node);

        if (calledSymbol && callerFunction?.name) {
          const callerSymbol = resolveSymbol(callerFunction.name);
          if (callerSymbol) {
            const caller = symbolToEntity.get(callerSymbol);
            const called = symbolToEntity.get(calledSymbol);

            if (caller && called) {
              emit({
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

    if (!extendedEngine) {
      visit(sourceFile);
      continue;
    }
    try {
      visit(sourceFile);
      for (const relation of fileRelations) addRelation(relation);
    } catch (error) {
      diagnostics.push({
        code: 'FILE_ANALYSIS_FAILED',
        severity: 'warning',
        file: normalizeProjectPath(sourceFile.fileName),
        message: `Call extraction failed (${errorClassName(error)}); calls from this file were skipped.`,
      });
    }
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
      entityKinds: [...((options.engine ?? DEFAULT_ENGINE) === 'extended' ? EXTENDED_ENTITY_KINDS : LEGACY_ENTITY_KINDS)],
      relationTypes: [...((options.engine ?? DEFAULT_ENGINE) === 'extended' ? EXTENDED_RELATION_TYPES : LEGACY_RELATION_TYPES)],
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
    diagnostics,
    parentById,
    entityById,
    reverseAdjacency,
    files,
    program,
    checker,
    symbolToEntity,
    toProjectPath: normalizeProjectPath,
  };
}
