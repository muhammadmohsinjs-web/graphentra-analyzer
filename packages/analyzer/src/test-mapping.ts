import * as ts from 'typescript';
import type { Entity } from './contracts';
import { isTestPath, lineOf, stringValue, toPath } from './application-map-ast';
import { matchesPathGlob } from './config';
import { compareStrings } from './deterministic';

/** Same shape as the contracts `TestNode` (D6). */
export interface TestNodeLike {
  id: string;
  file: string;
  line: number;
  name: string;
  framework: 'cypress' | 'jest' | 'node-test' | 'playwright' | 'unknown' | 'vitest';
}

export interface ExtractTestsInput {
  program: ts.Program;
  checker: ts.TypeChecker;
  symbolToEntity: Map<ts.Symbol, Entity>;
  files: string[];
  toProjectPath: (fileName: string) => string;
  testGlobs?: string[];
  isTestFile?: (projectPath: string) => boolean;
}

export interface ExtractTestsResult {
  tests: TestNodeLike[];
  coversEntities: Array<{ testId: string; entityId: string }>;
  visitsRoutes: Array<{ testId: string; route: string }>;
}

const TEST_ROOTS = new Set(['it', 'test', 'specify']);
const SUITE_ROOTS = new Set(['describe', 'context', 'suite']);
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'before', 'after', 'setup', 'teardown']);
const MODIFIERS = new Set([
  'only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'failing', 'each', 'fixme', 'slow',
  'serial', 'parallel', 'runIf', 'skipIf', 'for',
]);
const DYNAMIC = '<dynamic>';

interface Scope {
  parent?: Scope;
  entities: Set<string>;
  routes: Set<string>;
}

type CallKind =
  | { kind: 'test' | 'suite' | 'hook' };

function parseCallee(expression: ts.Expression): { root: string; members: string[] } | undefined {
  const members: string[] = [];
  let current: ts.Expression = expression;
  for (let hop = 0; hop < 12; hop += 1) {
    if (ts.isCallExpression(current)) current = current.expression;
    else if (ts.isTaggedTemplateExpression(current)) current = current.tag;
    else if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isPropertyAccessExpression(current)) { members.unshift(current.name.text); current = current.expression; }
    else if (ts.isIdentifier(current)) return { root: current.text, members };
    else return undefined;
  }
  return undefined;
}

function classify(call: ts.CallExpression): CallKind['kind'] | undefined {
  const callee = parseCallee(call.expression);
  if (!callee) return undefined;
  const { root, members } = callee;
  const hasFunction = call.arguments.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
  if (HOOKS.has(root)) return members.length === 0 && hasFunction ? 'hook' : undefined;
  if (TEST_ROOTS.has(root)) {
    if (members.length && HOOKS.has(members[0]!)) return hasFunction ? 'hook' : undefined;
    if (members[0] === 'describe') {
      return members.slice(1).every(m => MODIFIERS.has(m)) && hasFunction ? 'suite' : undefined;
    }
    if (!members.every(m => MODIFIERS.has(m))) return undefined;
    if (hasFunction) return 'test';
    const first = call.arguments[0];
    return members.includes('todo') && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ? 'test' : undefined;
  }
  if (SUITE_ROOTS.has(root)) {
    return members.every(m => MODIFIERS.has(m)) && hasFunction ? 'suite' : undefined;
  }
  return undefined;
}

function callName(call: ts.CallExpression): string {
  const first = call.arguments[0];
  if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
  return DYNAMIC;
}

function detectFramework(sf: ts.SourceFile, projectPath: string): TestNodeLike['framework'] {
  const modules = new Set<string>();
  let usesCy = false;
  let usesJest = false;
  const scan = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) modules.add(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) modules.add(arg.text);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'cy') usesCy = true;
      if (node.expression.text === 'jest') usesJest = true;
    }
    ts.forEachChild(node, scan);
  };
  try { scan(sf); } catch { /* ignore odd syntax */ }
  if (modules.has('@playwright/test')) return 'playwright';
  if (modules.has('vitest')) return 'vitest';
  if (modules.has('node:test')) return 'node-test';
  if (usesCy || /(^|\/)cypress\//i.test(projectPath.replace(/\\/g, '/'))) return 'cypress';
  if (modules.has('@jest/globals') || usesJest) return 'jest';
  return 'unknown';
}

export function extractTests(input: ExtractTestsInput): ExtractTestsResult {
  const { program, checker, symbolToEntity, files, toProjectPath, isTestFile } = input;
  const globs = input.testGlobs ?? [];
  const tests: TestNodeLike[] = [];
  const edges = new Map<string, string>();
  const routeEdges = new Map<string, string>();

  function entityIdFor(node: ts.Node): string | undefined {
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(node); } catch { return undefined; }
    const direct = symbol ? symbolToEntity.get(symbol) : undefined;
    if (direct) return direct.id;
    for (let hop = 0; symbol && hop < 6; hop += 1) {
      const declaration: ts.Declaration | undefined = symbol.declarations?.[0];
      let next: ts.Symbol | undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        try { next = checker.getAliasedSymbol(symbol); } catch { return undefined; }
      } else if (declaration && ts.isExportAssignment(declaration)) {
        next = checker.getSymbolAtLocation(declaration.expression);
      } else if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
        next = checker.getShorthandAssignmentValueSymbol(declaration);
      } else break;
      if (!next || next === symbol) break;
      symbol = next;
      const hit = symbolToEntity.get(symbol);
      if (hit) return hit.id;
    }
    return undefined;
  }

  function isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (!parent || ts.isPropertyAccessExpression(parent) || ts.isShorthandPropertyAssignment(parent)) return false;
    return 'name' in parent && (parent as { name?: ts.Node }).name === node;
  }

  for (const file of [...files].sort(compareStrings)) {
    try {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      const projectPath = toProjectPath(file);
      const isTest = isTestPath(projectPath) || isTestFile?.(projectPath) === true || globs.some(glob => matchesPathGlob(projectPath, glob));
      if (!isTest) continue;
      const framework = detectFramework(sf, projectPath);
      const used = new Map<string, number>();
      const found: Array<{ id: string; scope: Scope }> = [];
      const root: Scope = { entities: new Set(), routes: new Set() };

      const walk = (node: ts.Node, scope: Scope, suites: string[], inTest: boolean): void => {
        try {
          if (ts.isImportDeclaration(node)) return;
          if (ts.isCallExpression(node)) {
            const kind = inTest ? undefined : classify(node);
            if (kind === 'test') {
              const name = callName(node);
              const base = `test:${projectPath}#${[...suites, name].join(' > ')}`;
              const count = (used.get(base) ?? 0) + 1;
              used.set(base, count);
              const id = count === 1 ? base : `${base}#${count}`;
              const child: Scope = { parent: scope, entities: new Set(), routes: new Set() };
              tests.push({ id, file: projectPath, line: lineOf(node), name, framework });
              found.push({ id, scope: child });
              ts.forEachChild(node, c => walk(c, child, suites, true));
              return;
            }
            if (kind === 'suite') {
              const child: Scope = { parent: scope, entities: new Set(), routes: new Set() };
              const next = [...suites, callName(node)];
              ts.forEachChild(node, c => walk(c, child, next, false));
              return;
            }
            // hooks fall through: their references land in the enclosing (shared) scope
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) && node.arguments.length > 0) {
              const method = callee.name.text;
              const target = ts.isIdentifier(callee.expression) ? callee.expression.text : '';
              if (method === 'goto' || (method === 'visit' && (target === 'cy' || target === 'cypress'))) {
                const value = stringValue(node.arguments[0]);
                const route = value === undefined ? undefined : toPath(value);
                if (route) scope.routes.add(route);
              }
            }
          } else if (ts.isIdentifier(node) && !isDeclarationName(node)) {
            const id = entityIdFor(node);
            if (id) scope.entities.add(id);
          }
          ts.forEachChild(node, c => walk(c, scope, suites, inTest));
        } catch { /* skip odd node */ }
      };
      walk(sf, root, [], false);

      for (const { id, scope } of found) {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
          for (const entityId of s.entities) edges.set(`${id}\u0000${entityId}`, id);
          for (const route of s.routes) routeEdges.set(`${id}\u0000${route}`, id);
        }
      }
    } catch { /* never throw on odd files */ }
  }

  const split = (map: Map<string, string>): Array<[string, string]> => [...map.keys()]
    .map(key => key.split('\u0000') as [string, string])
    .sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  return {
    tests: tests.sort((a, b) => compareStrings(a.id, b.id)),
    coversEntities: split(edges).map(([testId, entityId]) => ({ testId, entityId })),
    visitsRoutes: split(routeEdges).map(([testId, route]) => ({ testId, route })),
  };
}
