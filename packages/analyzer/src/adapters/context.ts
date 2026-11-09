import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { ExtractApplicationMapInput } from '../application-map';
import { getProperty, isFunctionLike, isTestPath, stringValue, unwrapExpression } from '../application-map-ast';
import type { Entity } from '../contracts';
import type { AdapterContext, AdapterSourceFile, RedirectLink } from './types';

function readDependencies(projectRoot: string, file: string, cache: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  let directory = path.dirname(path.join(projectRoot, file));
  const root = path.resolve(projectRoot);
  for (let guard = 0; guard < 30; guard += 1) {
    let dependencies = cache.get(directory);
    if (!dependencies) {
      dependencies = new Set();
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
          for (const name of Object.keys(manifest?.[key] ?? {})) dependencies.add(name);
        }
      } catch { /* no manifest here */ }
      cache.set(directory, dependencies);
    }
    for (const name of dependencies) result.add(name);
    if (path.resolve(directory) === root || !directory.startsWith(root)) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return result;
}

/** Builds the shared program/symbol helpers that every adapter and the host extraction use. */
export function createAdapterContext(input: ExtractApplicationMapInput): AdapterContext {
  const { checker, symbolToEntity, toProjectPath } = input;
  const normalize = (file: string) => path.resolve(file).replace(/\\/g, '/');
  const analyzed = new Set(input.files.map(normalize));
  const sourceFiles = input.program.getSourceFiles()
    .filter(sourceFile => !sourceFile.isDeclarationFile && analyzed.has(normalize(sourceFile.fileName)));
  const relativeOf = (node: ts.Node) => toProjectPath(node.getSourceFile().fileName);
  const inAnalyzed = (node: ts.Node) => analyzed.has(normalize(node.getSourceFile().fileName));

  const entityDeclaration = new Map<string, ts.Node>();
  const entityForDeclaration = new Map<ts.Node, Entity>();
  for (const [symbol, entity] of symbolToEntity) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration) { entityDeclaration.set(entity.id, declaration); entityForDeclaration.set(declaration, entity); }
  }

  function resolve(node: ts.Node): ts.Symbol | undefined {
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(node); } catch { return undefined; }
    for (let hop = 0; symbol && hop < 6; hop += 1) {
      if (symbol.flags & ts.SymbolFlags.Alias) {
        const target = checker.getAliasedSymbol(symbol);
        if (!target || target === symbol || target.flags & ts.SymbolFlags.Alias && hop > 4) break;
        symbol = target;
        continue;
      }
      const declaration = symbol.declarations?.[0];
      if (declaration && ts.isExportAssignment(declaration)) {
        const next = checker.getSymbolAtLocation(declaration.expression);
        if (!next || next === symbol) break;
        symbol = next;
        continue;
      }
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
        const next = checker.getShorthandAssignmentValueSymbol(declaration);
        if (!next || next === symbol) break;
        symbol = next;
        continue;
      }
      break;
    }
    return symbol;
  }

  function symbolOf(expression: ts.Node): ts.Symbol | undefined {
    const target = ts.isExpression(expression as ts.Expression) ? unwrapExpression(expression as ts.Expression) : expression;
    if (ts.isPropertyAccessExpression(target)) return resolve(target.name);
    if (ts.isIdentifier(target) || ts.isJsxNamespacedName(target)) return resolve(target);
    return undefined;
  }

  function unwrapInitializer(expression: ts.Expression, hops: number): ts.Node | undefined {
    const target = unwrapExpression(expression);
    if (isFunctionLike(target) || ts.isClassExpression(target) || ts.isCallExpression(target) || ts.isObjectLiteralExpression(target)) return target;
    if ((ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) && hops < 4) {
      const symbol = symbolOf(target);
      return symbol ? declarationBody(symbol, hops + 1) : undefined;
    }
    return undefined;
  }

  /** The AST node to scan for a non-entity symbol (arrow components, classes, methods...). */
  function declarationBody(symbol: ts.Symbol, hops = 0): ts.Node | undefined {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration || !inAnalyzed(declaration)) return undefined;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isClassDeclaration(declaration) ||
        isFunctionLike(declaration) || ts.isClassExpression(declaration)) return declaration;
    if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
      return unwrapInitializer(declaration.initializer, hops);
    }
    if (ts.isPropertyAssignment(declaration)) return unwrapInitializer(declaration.initializer, hops);
    if (ts.isExportAssignment(declaration)) return unwrapInitializer(declaration.expression, hops);
    return undefined;
  }

  /** Resolves identifiers/property accesses that point to constant expressions (route constants). */
  function resolveConstant(expression: ts.Expression): ts.Expression | undefined {
    let symbol: ts.Symbol | undefined;
    if (ts.isElementAccessExpression(expression)) {
      const key = stringValue(expression.argumentExpression);
      const base = resolveConstant(expression.expression) ?? expression.expression;
      if (key && ts.isObjectLiteralExpression(unwrapExpression(base))) return getProperty(unwrapExpression(base) as ts.ObjectLiteralExpression, key);
      return undefined;
    }
    symbol = symbolOf(expression);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      // Only constants: `let`/`var` values and function parameters are runtime state.
      const list = declaration.parent;
      return ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const ? declaration.initializer : undefined;
    }
    if (ts.isPropertyAssignment(declaration)) {
      // `ROUTES.checkout` is a constant; `item.href` inside `menu.map(item => ...)` is not.
      let owner: ts.Node = declaration.parent.parent;
      while (ts.isAsExpression(owner) || ts.isSatisfiesExpression(owner) || ts.isParenthesizedExpression(owner)) owner = owner.parent;
      const isConstantObject = ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner);
      if (!isConstantObject) return undefined;
      if (ts.isPropertyAccessExpression(expression)) {
        const base = unwrapExpression(expression.expression);
        const baseSymbol = ts.isIdentifier(base) || ts.isPropertyAccessExpression(base) ? symbolOf(base) : undefined;
        const baseDeclaration = baseSymbol?.valueDeclaration;
        if (baseDeclaration && (ts.isParameter(baseDeclaration) || ts.isBindingElement(baseDeclaration))) return undefined;
      }
      return declaration.initializer;
    }
    if (ts.isEnumMember(declaration) && declaration.initializer) return declaration.initializer;
    return undefined;
  }
  const str = (expression: ts.Expression | undefined) => stringValue(expression, resolveConstant);

  function moduleDefault(specifier: ts.Expression | undefined): ts.Symbol | undefined {
    if (!specifier) return undefined;
    const moduleSymbol = resolve(specifier);
    if (!moduleSymbol) return undefined;
    try {
      const exported = checker.getExportsOfModule(moduleSymbol).find(symbol => symbol.escapedName === 'default');
      return exported ? (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported) : undefined;
    } catch { return undefined; }
  }

  function sourceFileExport(sourceFile: ts.SourceFile, name: string): ts.Symbol | undefined {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return undefined;
    const exported = checker.getExportsOfModule(moduleSymbol).find(symbol => symbol.escapedName === name);
    if (!exported) return undefined;
    let target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = target.declarations?.[0];
    if (declaration && ts.isExportAssignment(declaration)) target = checker.getSymbolAtLocation(declaration.expression) ?? target;
    return target;
  }

  const files: AdapterSourceFile[] = [];
  const dependencyCache = new Map<string, Set<string>>();
  sourceFiles.forEach((sourceFile, index) => {
    const file = toProjectPath(sourceFile.fileName);
    if (isTestPath(file)) return;
    files.push({ sourceFile, file, index, dependencies: readDependencies(input.projectRoot, file, dependencyCache) });
  });
  const memoCache = new Map<string, unknown>();

  return {
    program: input.program, checker, sourceFiles, files, projectRoot: input.projectRoot, entities: input.entities,
    symbolToEntity, entityDeclaration, entityForDeclaration, frameworks: new Set<string>(), redirectLinks: [] as RedirectLink[],
    toProjectPath, relativeOf, inAnalyzed, resolve, symbolOf, declarationBody, resolveConstant, str, moduleDefault, sourceFileExport,
    memo: <T>(key: string, factory: () => T): T => {
      if (!memoCache.has(key)) memoCache.set(key, factory());
      return memoCache.get(key) as T;
    },
  };
}
