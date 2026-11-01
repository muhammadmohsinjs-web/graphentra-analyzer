import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { collectEntities } from './entity-collector';
import { compareStrings } from './deterministic';
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
  type EdgeConfidence,
  type Entity,
  type EngineProfile,
  type FrontierItem,
  type FrontierReason,
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

/** Maximum frontier items kept per entity (decision D6). */
const FRONTIER_ITEM_CAP = 20;

/** An interface member or an abstract member: the call resolves to a declaration, not to the code that runs. */
function isInterfaceOrAbstractMember(declaration: ts.Declaration): boolean {
  if (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)) return true;
  if (ts.isMethodDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isAccessor(declaration)) {
    return (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Abstract) !== 0;
  }
  return false;
}

/** Decision D4: 'likely' for an interface/abstract member or a symbol with several declarations; undefined (proven) otherwise. */
function symbolConfidence(symbol: ts.Symbol | undefined): EdgeConfidence | undefined {
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 1 || declarations.some(isInterfaceOrAbstractMember) ? 'likely' : undefined;
}

const withConfidence = (relation: Relation, confidence: EdgeConfidence | undefined): Relation =>
  confidence === undefined ? relation : { ...relation, confidence };

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
  /** Extended engine only (empty for legacy): unresolved dependency sites, capped per entity and sorted by file, line, reason, entityId. */
  frontier: FrontierItem[];
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
  /** Called once per collected entity with its declaration node; nodes must not be retained past extraction. */
  onEntityNode?: (entity: Entity, node: ts.Node, sourceFile: ts.SourceFile) => void;
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
      frontier: [],
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
  const relationsByKey = new Map<string, Relation>();
  const frontier: FrontierItem[] = [];
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
    const existing = relationsByKey.get(key);
    if (existing) {
      // The stronger evidence wins: an absent confidence means proven.
      if (existing.confidence !== undefined && relation.confidence === undefined) delete existing.confidence;
      return;
    }
    relationsByKey.set(key, relation);
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
    const declared: Array<[Entity, ts.Node]> = [];
    try {
      for (const candidate of collectEntities(sourceFile, { relativeFile, engine: options.engine ?? DEFAULT_ENGINE })) {
        const entity = candidate.entity;
        if (entityById.has(entity.id)) throw new GraphentraError('Duplicate function identity in source.', 'AMBIGUOUS_ENTITY_ID');
        entities.push(entity);
        entityById.set(entity.id, entity);
        registered.push(entity);
        declared.push([entity, candidate.declarationNode]);
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
      for (const [entity, node] of declared) options.onEntityNode?.(entity, node, sourceFile);
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
    const fileFrontier: FrontierItem[] = [];
    const relativeFile = normalizeProjectPath(sourceFile.fileName);
    const isJavaScriptFile = JAVASCRIPT_EXTENSIONS.has(path.extname(sourceFile.fileName));
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

    // True when the expression is a direct argument of a call or `new` (callback position).
    function isCallArgument(node: ts.Expression): boolean {
      let child: ts.Node = node;
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) {
        child = parent;
        parent = parent.parent;
      }
      return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && (parent.arguments?.includes(child as ts.Expression) ?? false);
    }

    function recordFrontier(node: ts.Node, reason: FrontierReason): void {
      const entity = enclosingEntity(node);
      if (!entity) return;
      fileFrontier.push({ entityId: entity.id, file: relativeFile, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, reason });
    }

    // A global such as `eval`, `Function` or `require`: not redeclared by repository code.
    function isGlobalNamed(expression: ts.Expression, name: string): boolean {
      if (!ts.isIdentifier(expression) || expression.text !== name) return false;
      return !(resolveSymbol(expression)?.declarations ?? []).some(declaration => !declaration.getSourceFile().isDeclarationFile);
    }

    // The identifier a callee chain starts from: `a` in `a.b[c]().d`.
    function baseIdentifier(expression: ts.Expression): ts.Identifier | undefined {
      let current: ts.Expression = expression;
      while (true) {
        if (ts.isIdentifier(current)) return current;
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current)
          || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)
          || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
          current = current.expression;
          continue;
        }
        return undefined;
      }
    }

    // In plain JavaScript an `any` callee is the norm; only an explicit `any`/`unknown` annotation or an unresolvable base counts.
    function isUnknownCallee(callee: ts.Expression): boolean {
      if (!(checker.getTypeAtLocation(callee).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return false;
      if (!isJavaScriptFile) return true;
      const base = baseIdentifier(callee);
      if (!base) return false;
      const declaration = resolveSymbol(base)?.declarations?.[0];
      if (!declaration) return true;
      const annotation = (declaration as { type?: ts.TypeNode }).type;
      return annotation !== undefined && (annotation.kind === ts.SyntaxKind.AnyKeyword || annotation.kind === ts.SyntaxKind.UnknownKeyword);
    }

    // Records the places where resolution gives up (decision D6); the first matching pattern wins.
    function detectFrontier(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const base = baseIdentifier(node.tagName as ts.Expression);
        const declaration = base ? resolveSymbol(base)?.declarations?.[0] : undefined;
        if (declaration && (ts.isParameter(declaration) || ts.isBindingElement(declaration))) recordFrontier(node, 'jsx_prop_component');
      } else if (ts.isNewExpression(node)) {
        if (isGlobalNamed(node.expression, 'Function')) recordFrontier(node, 'function_constructor');
      } else if (ts.isCallExpression(node)) {
        let callee: ts.Expression = node.expression;
        while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
        const argument = node.arguments[0];
        const at = ts.isPropertyAccessExpression(callee) ? callee.name : node;
        if (ts.isDecorator(node.parent) && argument && (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '') === 'Inject') {
          recordFrontier(node, 'di_token');
        } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          if (argument && !ts.isStringLiteralLike(argument)) recordFrontier(node, 'dynamic_import');
        } else if (isGlobalNamed(callee, 'require')) {
          if (argument && !ts.isStringLiteralLike(argument)) recordFrontier(node, 'dynamic_require');
        } else if (isGlobalNamed(callee, 'eval')) {
          recordFrontier(node, 'eval');
        } else if (isGlobalNamed(callee, 'Function')) {
          recordFrontier(node, 'function_constructor');
        } else if (ts.isElementAccessExpression(callee) && !ts.isStringLiteralLike(callee.argumentExpression) && !ts.isNumericLiteral(callee.argumentExpression)) {
          recordFrontier(at, 'computed_member_call');
        } else if (callee.kind !== ts.SyntaxKind.SuperKeyword && isUnknownCallee(callee)) {
          recordFrontier(at, 'any_typed_call');
        }
      }
    }

    function visit(node: ts.Node): void {
      if (extendedEngine) {
        detectFrontier(node);
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          // Lowercase tags are intrinsic elements (`div`), not symbols.
          const tag = node.tagName;
          if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text))) {
            const caller = enclosingEntity(node);
            const rendered = entityOfSymbol(ts.isPropertyAccessExpression(tag) ? resolveSymbol(tag.name) : resolveSymbol(tag));
            if (caller && rendered && caller.id !== rendered.id) {
              emit(withConfidence({ from: caller.id, to: rendered.id, type: 'RENDERS' }, symbolConfidence(ts.isPropertyAccessExpression(tag) ? resolveSymbol(tag.name) : resolveSymbol(tag))));
            }
          }
        } else if (ts.isShorthandPropertyAssignment(node)) {
          const caller = enclosingEntity(node);
          const valueSym = checker.getShorthandAssignmentValueSymbol(node);
          const referenced = isFunctionValue(valueSym) ? entityOfSymbol(valueSym) : undefined;
          if (caller && referenced && caller.id !== referenced.id) emit(withConfidence({ from: caller.id, to: referenced.id, type: 'REFERENCES' }, symbolConfidence(valueSym)));
        } else if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && isValuePosition(node)) {
          const caller = enclosingEntity(node);
          const valueSym = valueSymbol(node);
          const referenced = isFunctionValue(valueSym) ? entityOfSymbol(valueSym) : undefined;
          if (caller && referenced && caller.id !== referenced.id) {
            emit(withConfidence({ from: caller.id, to: referenced.id, type: 'REFERENCES' }, isCallArgument(node) ? 'likely' : symbolConfidence(valueSym)));
          }
        }
      }
      if (ts.isNewExpression(node) && extendedEngine) {
        // The resolved signature names the constructor that runs, including an inherited one
        // (or the function, for a JavaScript constructor function).
        // Overloads resolve to a bodiless declaration, so fall back to the implementation.
        // A class with no constructor anywhere in its chain has no entity to target and gets no edge.
        let declaration = checker.getResolvedSignature(node)?.declaration;
        // Constructor overloads are several declarations of one symbol; any other target follows the symbol rule.
        const overloaded = declaration && ts.isConstructorDeclaration(declaration)
          ? declaration.parent.members.filter(ts.isConstructorDeclaration).length > 1
          : symbolConfidence(resolveSymbol(node.expression)) === 'likely';
        if (declaration && ts.isConstructorDeclaration(declaration) && !declaration.body) {
          declaration = declaration.parent.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && !!member.body);
        }
        const caller = enclosingEntity(node);
        const constructed = declaration ? declarationToEntity.get(declaration) : undefined;
        if (caller && constructed) emit(withConfidence({ from: caller.id, to: constructed.id, type: 'INSTANTIATES' }, overloaded ? 'likely' : undefined));
      } else if (ts.isCallExpression(node) && extendedEngine) {
        const caller = enclosingEntity(node);
        const calledSymbol = resolveSymbol(node.expression);
        // Widened object-literal types hand back cloned property symbols, so fall back to the single declaration node.
        const calledDeclaration = calledSymbol?.declarations?.length === 1 ? calledSymbol.declarations[0] : undefined;
        const called = calledSymbol
          ? symbolToEntity.get(calledSymbol) ?? (calledDeclaration ? declarationToEntity.get(calledDeclaration) : undefined)
          : undefined;
        if (caller && called) emit(withConfidence({ from: caller.id, to: called.id, type: 'CALLS' }, symbolConfidence(calledSymbol)));
        // D15: interface and abstract members declared in repository source have no entity, so the call gives no edge;
        // report it as a frontier site. Members declared in .d.ts files (lib, dependencies) are outside the repository.
        else if (caller && !called && (calledSymbol?.declarations ?? []).some(declaration =>
          isInterfaceOrAbstractMember(declaration) && !declaration.getSourceFile().isDeclarationFile)) {
          recordFrontier(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node, 'interface_dispatch');
        }
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
      frontier.push(...fileFrontier);
    } catch (error) {
      diagnostics.push({
        code: 'FILE_ANALYSIS_FAILED',
        severity: 'warning',
        file: normalizeProjectPath(sourceFile.fileName),
        message: `Call extraction failed (${errorClassName(error)}); calls from this file were skipped.`,
      });
    }
  }

  // Frontier: sorted, de-duplicated and capped per entity (decision D6).
  const keptFrontier: FrontierItem[] = [];
  if (extendedEngine) {
    const ordered = frontier.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.reason, b.reason) || compareStrings(a.entityId, b.entityId));
    const perEntity = new Map<string, number>();
    const capped = new Set<string>();
    for (const [index, item] of ordered.entries()) {
      const previous = ordered[index - 1];
      if (previous && previous.file === item.file && previous.line === item.line && previous.reason === item.reason && previous.entityId === item.entityId) continue;
      const count = perEntity.get(item.entityId) ?? 0;
      if (count >= FRONTIER_ITEM_CAP) {
        capped.add(item.entityId);
        continue;
      }
      perEntity.set(item.entityId, count + 1);
      keptFrontier.push(item);
    }
    for (const entityId of [...capped].sort(compareStrings)) {
      diagnostics.push({
        code: 'FRONTIER_CAPPED',
        severity: 'info',
        entityId,
        message: `More than ${FRONTIER_ITEM_CAP} unresolved dependency sites; only the first ${FRONTIER_ITEM_CAP} in sorted order are reported.`,
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
    frontier: keptFrontier,
    program,
    checker,
    symbolToEntity,
    toProjectPath: normalizeProjectPath,
  };
}
