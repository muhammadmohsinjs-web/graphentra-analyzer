import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ANALYZER_VERSION, type Entity, type Relation } from './contracts';
import {
  GUARD_NAME, PARAM, calleeName, clean, dynamicSegmentCount, getProperty, hasProperty, isFunctionLike, isTestPath,
  joinRoute, lineOf, propertyName, receiverText, routeMatches, stringArray, stringValue, toPath, unwrapExpression,
} from './application-map-ast';
import { extractE2EFlows, type E2EFlow } from './application-map-e2e';

export type { E2EFlow } from './application-map-e2e';
export { routeMatches } from './application-map-ast';

export const APPLICATION_MAP_SCHEMA_VERSION = '1.0' as const;
export const MAX_SURFACE_REACH_DEPTH = 10;
const MAX_UI_TEXT = 20;
const MAX_SCAN_DEPTH = 4;

export type SurfaceKind = 'ui_route' | 'api_endpoint';
export type SurfaceSource =
  | 'next-app-router' | 'next-pages-router' | 'next-route-handler'
  | 'jsx-route' | 'route-config' | 'http-router' | 'nestjs';

export interface AccessHint {
  kind: 'guard' | 'role' | 'public';
  value: string;
  file: string;
  line: number;
}

/** A place a person (UI route) or another system (API endpoint) can use. */
export interface Surface {
  id: string;
  kind: SurfaceKind;
  route: string;
  method?: string;
  source: SurfaceSource;
  file: string;
  line: number;
  entryName?: string;
  /** Graph entities the surface directly renders, handles with, or calls. */
  entryEntityIds: string[];
  access: AccessHint[];
  /** Visible labels found in the surface's own component tree (headings, buttons, titles). */
  uiText: string[];
  /** Translation keys used by the surface (resolved against locale files by reporting). */
  textKeys: string[];
  /** Deterministic click path from a start page or global navigation; empty when unknown. */
  navigation: string[];
}

export interface NavigationLink {
  kind: 'link' | 'navigate' | 'redirect' | 'menu';
  target: string;
  label?: string;
  file: string;
  line: number;
  fromEntityId?: string;
  /** Surfaces that render this link; empty means global navigation or an unmapped component. */
  fromSurfaceIds: string[];
  targetSurfaceIds: string[];
}

export interface ClientRequest {
  method: string;
  target: string;
  file: string;
  line: number;
  fromEntityId?: string;
  fromSurfaceIds: string[];
  targetSurfaceIds: string[];
}

export interface SupplementalRelation {
  from: string;
  to: string;
  type: 'RENDERS' | 'REFERENCES';
}

export interface ApplicationMap {
  schemaVersion: typeof APPLICATION_MAP_SCHEMA_VERSION;
  analyzerVersion: string;
  headSha: string;
  platform: { frontend: boolean; backend: boolean; frameworks: string[] };
  surfaces: Surface[];
  navigation: NavigationLink[];
  requests: ClientRequest[];
  e2eFlows: E2EFlow[];
  /** JSX renders and function references that the CALLS graph does not model. */
  relations: SupplementalRelation[];
  /** Content hash of each entity's source, used to detect stale semantic context. */
  entityFingerprints: Record<string, string>;
  limitations: string[];
}

export interface ExtractApplicationMapInput {
  program: ts.Program;
  checker: ts.TypeChecker;
  symbolToEntity: Map<ts.Symbol, Entity>;
  entities: Entity[];
  relations: Relation[];
  files: string[];
  toProjectPath: (fileName: string) => string;
  projectRoot: string;
  headSha: string;
}

const APPLICATION_MAP_LIMITATIONS = [
  'Surfaces are discovered from static TypeScript routing patterns (Next.js, React Router, route configs, Express-style routers, NestJS); JavaScript, Vue SFC, and dynamically built routes are not discovered.',
  'Navigation paths use statically visible links, menus, and navigate/push calls; conditional visibility and runtime state are not evaluated.',
  'Access hints are names of guards, roles, and middleware; they do not prove enforced authorization.',
  'Client request matching compares static URL templates with endpoint routes and may miss proxied or computed URLs.',
];

const TEXT_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'label', 'alt', 'heading', 'header', 'buttonText', 'description']);
const I18N_FUNCTIONS = new Set(['t', '$t', 'translate', 'formatMessage', 'i18n', 'useTranslation']);
const ROUTE_ENTRY_KEYS = ['element', 'component', 'Component', 'loadComponent', 'lazy', 'page'];
const ROUTE_KEYS = [...ROUTE_ENTRY_KEYS, 'children', 'redirectTo', 'loader', 'index'];
const NEST_METHODS = new Map([['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'], ['Delete', 'DELETE'], ['All', 'ANY'], ['Options', 'OPTIONS'], ['Head', 'HEAD']]);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const NEXT_HANDLER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

interface ScanResult {
  refs: Map<string, SupplementalRelation['type']>;
  roots: ts.Node[];
  uiText: string[];
  textKeys: string[];
}

interface PendingSurface {
  kind: SurfaceKind;
  route: string;
  method?: string;
  source: SurfaceSource;
  node: ts.Node;
  entry?: ts.Expression | ts.Node;
  entrySymbol?: ts.Symbol;
  access: AccessHint[];
  labels: string[];
}

export function fingerprintSource(text: string): string {
  const normalized = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim()).join('\n');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

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

export function extractApplicationMap(input: ExtractApplicationMapInput): ApplicationMap {
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

  // ---------- symbol helpers ----------
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

  // ---------- scanning ----------
  function isReferencePosition(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;
    if (!parent) return false;
    if (ts.isJsxExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isReturnStatement(parent)) return true;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.arguments?.includes(identifier) ?? false;
    if (ts.isPropertyAssignment(parent)) return parent.initializer === identifier;
    if (ts.isShorthandPropertyAssignment(parent)) return true;
    if (ts.isVariableDeclaration(parent)) return parent.initializer === identifier;
    return false;
  }

  function scan(root: ts.Node, selfEntityId?: string): ScanResult {
    const result: ScanResult = { refs: new Map(), roots: [], uiText: [], textKeys: [] };
    const seen = new Set<ts.Node>();
    const queue: Array<[ts.Node, number]> = [[root, 0]];
    const addText = (value: string | undefined) => {
      const text = value ? clean(value) : undefined;
      if (text && result.uiText.length < MAX_UI_TEXT * 2 && !result.uiText.includes(text)) result.uiText.push(text);
    };
    const handle = (symbol: ts.Symbol | undefined, type: SupplementalRelation['type'], depth: number) => {
      if (!symbol) return;
      const entity = symbolToEntity.get(symbol);
      if (entity) {
        if (entity.id !== selfEntityId && (type === 'RENDERS' || !result.refs.has(entity.id))) result.refs.set(entity.id, type);
        return;
      }
      if (depth >= MAX_SCAN_DEPTH) return;
      const body = declarationBody(symbol);
      if (body && !seen.has(body) && !entityForDeclaration.has(body)) queue.push([body, depth + 1]);
      else if (body && entityForDeclaration.has(body)) handle(resolve((body as ts.FunctionDeclaration).name!), type, depth);
    };
    while (queue.length) {
      const [node, depth] = queue.shift()!;
      if (seen.has(node)) continue;
      seen.add(node);
      result.roots.push(node);
      const visit = (current: ts.Node): void => {
        // Nested named functions are separate graph entities with their own CALLS.
        if (current !== node && ts.isFunctionDeclaration(current) && current.name && entityForDeclaration.has(current)) return;
        // Decorators are routing/DI metadata, not behaviour reached by the surface.
        if (ts.isDecorator(current)) return;
        if (ts.isCallExpression(current)) {
          if (current.expression.kind === ts.SyntaxKind.ImportKeyword) handle(moduleDefault(current.arguments[0]), 'REFERENCES', depth);
          else {
            handle(symbolOf(current.expression), 'REFERENCES', depth);
            const name = calleeName(current.expression);
            const key = name && I18N_FUNCTIONS.has(name) ? str(current.arguments[0]) : undefined;
            if (key && !key.includes(' ') && result.textKeys.length < 60 && !result.textKeys.includes(key)) result.textKeys.push(key);
            else if (key) addText(key);
          }
        } else if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) {
          const tag = current.tagName;
          if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text))) handle(symbolOf(tag), 'RENDERS', depth);
          for (const attribute of current.attributes.properties) {
            if (!ts.isJsxAttribute(attribute)) continue;
            const attributeName = propertyName(attribute.name);
            if (attributeName && TEXT_ATTRIBUTES.has(attributeName) && attribute.initializer) {
              addText(ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text
                : attribute.initializer.kind === ts.SyntaxKind.JsxExpression ? str((attribute.initializer as ts.JsxExpression).expression) : undefined);
            }
          }
        } else if (ts.isJsxText(current)) {
          addText(current.text);
        } else if (ts.isIdentifier(current) && isReferencePosition(current)) {
          handle(resolve(current), 'REFERENCES', depth);
        }
        ts.forEachChild(current, visit);
      };
      visit(node);
    }
    return result;
  }

  const entityScans = new Map<string, ScanResult>();
  for (const [id, declaration] of entityDeclaration) entityScans.set(id, scan(declaration, id));

  // ---------- supplemental relations + adjacency ----------
  const callKeys = new Set(input.relations.map(relation => `${relation.from}|${relation.to}`));
  const supplemental: SupplementalRelation[] = [];
  for (const [from, result] of entityScans) {
    for (const [to, type] of result.refs) {
      if (from !== to && !callKeys.has(`${from}|${to}`)) supplemental.push({ from, to, type });
    }
  }
  supplemental.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`));
  const forward = new Map<string, Set<string>>();
  for (const relation of [...input.relations, ...supplemental]) {
    if (!forward.has(relation.from)) forward.set(relation.from, new Set());
    forward.get(relation.from)!.add(relation.to);
  }

  // ---------- surface discovery ----------
  const dependencyCache = new Map<string, Set<string>>();
  const frameworks = new Set<string>();
  const pending: PendingSurface[] = [];

  function guardHintsFromExpression(expression: ts.Node, file: string, hints: AccessHint[]): void {
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        if (GUARD_NAME.test(tag)) hints.push({ kind: 'guard', value: tag, file, line: lineOf(node) });
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
          const name = propertyName(attribute.name) ?? '';
          if (/^(roles?|allowedRoles|permissions?|requiredRole|scopes?)$/i.test(name)) {
            const value = ts.isStringLiteral(attribute.initializer) ? [attribute.initializer.text]
              : stringArray((attribute.initializer as ts.JsxExpression).expression, resolveConstant);
            for (const role of value) hints.push({ kind: 'role', value: role, file, line: lineOf(attribute) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
  }

  function guardHintsFromObject(object: ts.ObjectLiteralExpression, file: string): AccessHint[] {
    const hints: AccessHint[] = [];
    const visit = (literal: ts.ObjectLiteralExpression) => {
      for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name) ?? '';
        const value = unwrapExpression(property.initializer);
        if (/^(meta|data|handle)$/.test(name) && ts.isObjectLiteralExpression(value)) { visit(value); continue; }
        if (/^(canActivate|canActivateChild|canLoad|canMatch|guards?|middleware|beforeEnter)$/i.test(name)) {
          for (const guard of stringArray(value, resolveConstant)) hints.push({ kind: 'guard', value: guard, file, line: lineOf(property) });
          if (!ts.isArrayLiteralExpression(value)) hints.push({ kind: 'guard', value: value.getText().slice(0, 60), file, line: lineOf(property) });
        } else if (/^(roles?|allowedRoles|permissions?|requiredRoles?|scopes?)$/i.test(name)) {
          for (const role of stringArray(value, resolveConstant)) hints.push({ kind: 'role', value: role, file, line: lineOf(property) });
        } else if (/^(requiresAuth|auth|authRequired|protected|private|requireAuth)$/i.test(name) && value.kind === ts.SyntaxKind.TrueKeyword) {
          hints.push({ kind: 'guard', value: `${name}: true`, file, line: lineOf(property) });
        } else if (/^(public|allowAnonymous|guestOnly)$/i.test(name) && value.kind === ts.SyntaxKind.TrueKeyword) {
          hints.push({ kind: 'public', value: name, file, line: lineOf(property) });
        }
      }
    };
    visit(object);
    return hints;
  }

  function routeLabels(object: ts.ObjectLiteralExpression): string[] {
    const labels: string[] = [];
    const visit = (literal: ts.ObjectLiteralExpression) => {
      for (const key of ['title', 'name', 'label', 'breadcrumb']) {
        const value = str(getProperty(literal, key));
        const text = value ? clean(value) : undefined;
        if (text) labels.push(text);
      }
      for (const key of ['meta', 'data', 'handle']) {
        const nested = getProperty(literal, key);
        if (nested && ts.isObjectLiteralExpression(unwrapExpression(nested))) visit(unwrapExpression(nested) as ts.ObjectLiteralExpression);
      }
    };
    visit(object);
    return labels;
  }

  // React Router / Vue Router / Angular style route configuration objects.
  function isRouteObject(node: ts.Node): node is ts.ObjectLiteralExpression {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const pathValue = getProperty(node, 'path');
    const hasPath = pathValue !== undefined && str(pathValue) !== undefined;
    const isIndex = getProperty(node, 'index')?.kind === ts.SyntaxKind.TrueKeyword;
    return (hasPath || isIndex) && hasProperty(node, ROUTE_KEYS) && !getProperty(node, 'method') && !getProperty(node, 'url');
  }

  function processRouteObject(object: ts.ObjectLiteralExpression, prefix: string, inherited: AccessHint[], file: string): void {
    const raw = str(getProperty(object, 'path'));
    const route = raw !== undefined && raw.startsWith('/') ? joinRoute(raw) : joinRoute(prefix, raw ?? '');
    const access = [...inherited, ...guardHintsFromObject(object, file)];
    const redirect = str(getProperty(object, 'redirectTo'));
    const entryKey = ROUTE_ENTRY_KEYS.find(key => getProperty(object, key) !== undefined);
    if (entryKey && !redirect) {
      const entry = getProperty(object, entryKey)!;
      guardHintsFromExpression(entry, file, access);
      pending.push({ kind: 'ui_route', route, source: 'route-config', node: object, entry, access, labels: routeLabels(object) });
    }
    if (redirect) redirectLinks.push({ node: object, target: redirect.startsWith('/') ? redirect : joinRoute(prefix, redirect), from: route });
    for (const key of ['children', 'routes']) {
      const children = getProperty(object, key);
      const list = children ? unwrapExpression(children) : undefined;
      if (list && ts.isArrayLiteralExpression(list)) {
        for (const child of list.elements) if (isRouteObject(unwrapExpression(child as ts.Expression))) {
          processRouteObject(unwrapExpression(child as ts.Expression) as ts.ObjectLiteralExpression, route, access, file);
        }
      }
    }
  }

  function jsxAttribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
    return element.attributes.properties.find((property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && propertyName(property.name) === name);
  }
  function jsxAttributeValue(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
    if (!attribute?.initializer) return undefined;
    if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
    if (ts.isJsxExpression(attribute.initializer)) return attribute.initializer.expression;
    return undefined;
  }
  const isRouteTag = (element: ts.JsxOpeningLikeElement) => /(^|\.)(\w*Route)$/.test(element.tagName.getText()) &&
    !/Routes$/.test(element.tagName.getText());

  function processJsxRoute(element: ts.JsxElement | ts.JsxSelfClosingElement, prefix: string, inherited: AccessHint[], file: string): void {
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    const raw = str(jsxAttributeValue(jsxAttribute(opening, 'path')));
    const route = raw !== undefined && raw.startsWith('/') ? joinRoute(raw) : joinRoute(prefix, raw ?? '');
    const access = [...inherited];
    const tag = opening.tagName.getText();
    if (GUARD_NAME.test(tag)) access.push({ kind: 'guard', value: tag, file, line: lineOf(opening) });
    guardHintsFromExpression(opening, file, access);
    const entry = ['element', 'component', 'Component', 'render'].map(name => jsxAttributeValue(jsxAttribute(opening, name))).find(Boolean);
    if (entry) {
      guardHintsFromExpression(entry, file, access);
      pending.push({ kind: 'ui_route', route, source: 'jsx-route', node: opening, entry, access, labels: [] });
    }
    if (ts.isJsxElement(element)) {
      const visitChildren = (node: ts.Node) => {
        for (const child of (node as ts.JsxElement).children ?? []) {
          if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
            const childOpening = ts.isJsxElement(child) ? child.openingElement : child;
            if (isRouteTag(childOpening)) processJsxRoute(child, route, access, file);
            else if (ts.isJsxElement(child)) visitChildren(child);
          }
        }
      };
      visitChildren(element);
    }
  }

  // Express / Koa / Fastify / Hono style routers.
  interface Registration { receiver?: ts.Symbol; route: string; method: string; handler: ts.Expression; middleware: ts.Expression[]; node: ts.Node }
  const registrations: Registration[] = [];
  const mounts: Array<{ parent?: ts.Symbol; child: ts.Symbol; prefix: string }> = [];
  const routerGuards = new Map<ts.Symbol, AccessHint[]>();
  const redirectLinks: Array<{ node: ts.Node; target: string; from?: string }> = [];

  function isHandlerLike(expression: ts.Expression | undefined, depth = 0): boolean {
    if (!expression || depth > 3) return false;
    const target = unwrapExpression(expression);
    if (isFunctionLike(target)) return true;
    if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) {
      const symbol = symbolOf(target);
      if (!symbol) return false;
      if (symbolToEntity.has(symbol)) return true;
      const body = declarationBody(symbol);
      return Boolean(body && (isFunctionLike(body) || ts.isFunctionDeclaration(body) || ts.isMethodDeclaration(body)));
    }
    if (ts.isCallExpression(target)) {
      const name = calleeName(target.expression);
      if (name === 'bind' && ts.isPropertyAccessExpression(target.expression)) return isHandlerLike(target.expression.expression, depth + 1);
      return target.arguments.some(argument => isHandlerLike(argument, depth + 1));
    }
    return false;
  }

  function receiverSymbol(expression: ts.Expression): ts.Symbol | undefined {
    const target = unwrapExpression(expression);
    if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) return symbolOf(target);
    return undefined;
  }

  function collectRouterCall(call: ts.CallExpression): void {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    const method = call.expression.name.text;
    const receiver = call.expression.expression;
    if (method === 'use' || method === 'register') {
      const [first, second] = call.arguments;
      const prefix = str(first);
      if (method === 'use' && prefix?.startsWith('/') && second) {
        for (const child of call.arguments.slice(1)) {
          const symbol = receiverSymbol(child);
          if (symbol) mounts.push({ parent: receiverSymbol(receiver), child: symbol, prefix });
        }
      } else if (method === 'register' && first) {
        const options = second && ts.isObjectLiteralExpression(unwrapExpression(second)) ? unwrapExpression(second) as ts.ObjectLiteralExpression : undefined;
        const registered = str(options ? getProperty(options, 'prefix') : undefined);
        const symbol = receiverSymbol(first);
        if (symbol && registered) mounts.push({ parent: receiverSymbol(receiver), child: symbol, prefix: registered });
      } else if (method === 'use') {
        const owner = receiverSymbol(receiver);
        for (const argument of call.arguments) {
          const name = argument.getText();
          if (owner && GUARD_NAME.test(name) && name.length < 80) {
            if (!routerGuards.has(owner)) routerGuards.set(owner, []);
            routerGuards.get(owner)!.push({ kind: 'guard', value: name, file: relativeOf(call), line: lineOf(call) });
          }
        }
      }
      return;
    }
    if (method === 'route' && call.arguments.length === 1) {
      const options = unwrapExpression(call.arguments[0]!);
      if (ts.isObjectLiteralExpression(options)) {
        const url = str(getProperty(options, 'url') ?? getProperty(options, 'path'));
        const handler = getProperty(options, 'handler');
        if (url?.startsWith('/') && handler) {
          for (const verb of stringArray(getProperty(options, 'method'), resolveConstant)) {
            registrations.push({ receiver: receiverSymbol(receiver), route: url, method: verb.toUpperCase(), handler, middleware: [], node: call });
          }
        }
      }
      return;
    }
    if (!HTTP_METHODS.has(method) || call.arguments.length < 2) return;
    let route = str(call.arguments[0]);
    let owner: ts.Expression = receiver;
    const chained = unwrapExpression(receiver);
    // router.route('/orders').get(handler)
    if (route === undefined && ts.isCallExpression(chained) && calleeName(chained.expression) === 'route' &&
        ts.isPropertyAccessExpression(chained.expression)) {
      route = str(chained.arguments[0]);
      owner = chained.expression.expression;
      const handler = call.arguments[call.arguments.length - 1];
      if (route?.startsWith('/') && isHandlerLike(handler)) {
        registrations.push({ receiver: receiverSymbol(owner), route, method: method === 'all' ? 'ANY' : method.toUpperCase(), handler: handler!, middleware: [...call.arguments.slice(0, -1)], node: call });
      }
      return;
    }
    if (!route?.startsWith('/')) return;
    const handler = call.arguments[call.arguments.length - 1]!;
    if (!isHandlerLike(handler)) return;
    registrations.push({ receiver: receiverSymbol(owner), route, method: method === 'all' ? 'ANY' : method.toUpperCase(), handler, middleware: [...call.arguments.slice(1, -1)], node: call });
  }

  function prefixesFor(symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): string[] {
    if (!symbol || seen.has(symbol)) return [''];
    seen.add(symbol);
    const parents = mounts.filter(mount => mount.child === symbol);
    if (!parents.length) return [''];
    return parents.flatMap(mount => prefixesFor(mount.parent, seen).map(prefix => joinRoute(prefix, mount.prefix)));
  }

  function routerGuardsFor(symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): AccessHint[] {
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    return [...(routerGuards.get(symbol) ?? []), ...mounts.filter(mount => mount.child === symbol).flatMap(mount => routerGuardsFor(mount.parent, seen))];
  }

  // NestJS controllers.
  function decorators(node: ts.Node): ts.Decorator[] {
    return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
  }
  function decoratorCall(decorator: ts.Decorator): { name?: string; args: readonly ts.Expression[] } {
    const expression = decorator.expression;
    if (ts.isCallExpression(expression)) return { name: calleeName(expression.expression), args: expression.arguments };
    return { name: calleeName(expression), args: [] };
  }
  function nestAccess(node: ts.Node, file: string): AccessHint[] {
    const hints: AccessHint[] = [];
    for (const decorator of decorators(node)) {
      const { name, args } = decoratorCall(decorator);
      if (!name) continue;
      if (name === 'UseGuards') for (const argument of args) hints.push({ kind: 'guard', value: argument.getText(), file, line: lineOf(decorator) });
      else if (/^(Roles|Permissions|RequirePermissions|RequireRoles|Scopes)$/.test(name)) for (const value of args.flatMap(arg => stringArray(arg, resolveConstant))) hints.push({ kind: 'role', value, file, line: lineOf(decorator) });
      else if (/^(Public|AllowAnonymous|SkipAuth)$/.test(name)) hints.push({ kind: 'public', value: name, file, line: lineOf(decorator) });
      else if (GUARD_NAME.test(name)) hints.push({ kind: 'guard', value: name, file, line: lineOf(decorator) });
    }
    return hints;
  }
  function processNestController(declaration: ts.ClassDeclaration, file: string): void {
    const controller = decorators(declaration).map(decoratorCall).find(item => item.name === 'Controller');
    if (!controller) return;
    frameworks.add('nestjs');
    const first = controller.args[0];
    const prefix = first && ts.isObjectLiteralExpression(unwrapExpression(first))
      ? str(getProperty(unwrapExpression(first) as ts.ObjectLiteralExpression, 'path')) : str(first);
    const classAccess = nestAccess(declaration, file);
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      for (const decorator of decorators(member)) {
        const { name, args } = decoratorCall(decorator);
        const method = name ? NEST_METHODS.get(name) : undefined;
        if (!method) continue;
        const sub = args[0] && ts.isArrayLiteralExpression(unwrapExpression(args[0])) ? stringArray(args[0], resolveConstant) : [str(args[0]) ?? ''];
        for (const route of sub) {
          pending.push({ kind: 'api_endpoint', route: joinRoute(prefix ?? '', route), method, source: 'nestjs', node: member, entry: member,
            access: [...classAccess, ...nestAccess(member, file)], labels: [] });
        }
      }
    }
  }

  // Next.js file-system routing.
  function processNextFile(sourceFile: ts.SourceFile, file: string): void {
    const appMatch = /(?:^|\/)app\/((?:.*\/)?)(page|route)\.tsx?$/.exec(file);
    const pagesMatch = !appMatch ? /(?:^|\/)pages\/(.+)\.tsx?$/.exec(file) : null;
    const segmentsToRoute = (value: string) => joinRoute(...value.split('/')
      .filter(segment => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@') && !segment.startsWith('_')));
    if (appMatch) {
      const route = segmentsToRoute(appMatch[1]!);
      if (appMatch[2] === 'page') {
        const entrySymbol = sourceFileExport(sourceFile, 'default');
        if (entrySymbol) pending.push({ kind: 'ui_route', route, source: 'next-app-router', node: sourceFile, entrySymbol, access: [], labels: [] });
      } else {
        for (const method of NEXT_HANDLER_METHODS) {
          const entrySymbol = sourceFileExport(sourceFile, method);
          if (entrySymbol) pending.push({ kind: 'api_endpoint', route, method, source: 'next-route-handler', node: sourceFile, entrySymbol, access: [], labels: [] });
        }
      }
      return;
    }
    if (pagesMatch) {
      const relativePage = pagesMatch[1]!;
      if (/(^|\/)_(app|document|error|middleware)$/.test(relativePage)) return;
      const route = segmentsToRoute(relativePage.replace(/(^|\/)index$/, ''));
      const entrySymbol = sourceFileExport(sourceFile, 'default');
      if (!entrySymbol) return;
      const isApi = /^api(\/|$)/.test(relativePage);
      pending.push({ kind: isApi ? 'api_endpoint' : 'ui_route', route, method: isApi ? 'ANY' : undefined,
        source: 'next-pages-router', node: sourceFile, entrySymbol, access: [], labels: [] });
    }
  }

  // ---------- navigation + requests (collected in the same pass) ----------
  interface RawLink { node: ts.Node; kind: NavigationLink['kind']; target: string; label?: string }
  interface RawRequest { node: ts.Node; method: string; target: string }
  const rawLinks: RawLink[] = [];
  const rawRequests: RawRequest[] = [];

  function textOfJsx(node: ts.Node): string | undefined {
    const parts: string[] = [];
    const visit = (current: ts.Node) => {
      if (ts.isJsxText(current)) parts.push(current.text);
      else if (ts.isJsxExpression(current) && current.expression) {
        const value = str(current.expression);
        if (value) parts.push(value);
        else if (ts.isCallExpression(current.expression) && I18N_FUNCTIONS.has(calleeName(current.expression.expression) ?? '')) {
          const key = str(current.expression.arguments[0]);
          if (key) parts.push(`{${key}}`);
        }
      } else ts.forEachChild(current, visit);
    };
    if (ts.isJsxElement(node)) node.children.forEach(visit);
    else ts.forEachChild(node, visit);
    return clean(parts.join(' '), 80);
  }

  function elementLabel(opening: ts.JsxOpeningLikeElement): string | undefined {
    const element = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
    return str(jsxAttributeValue(jsxAttribute(opening, 'aria-label'))) ?? str(jsxAttributeValue(jsxAttribute(opening, 'title'))) ??
      (ts.isJsxElement(element) ? textOfJsx(element) : undefined);
  }

  function labelForCall(call: ts.Node): string | undefined {
    for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
      if (ts.isJsxAttribute(current)) return elementLabel(current.parent.parent as ts.JsxOpeningLikeElement);
      // const submit = () => navigate('/x'); ... <button onClick={submit}>Place order</button>
      if (isFunctionLike(current) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        const handlerName = current.parent.name.text;
        let scope: ts.Node | undefined = current.parent.parent;
        while (scope && !ts.isFunctionDeclaration(scope) && !isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        let label: string | undefined;
        const find = (node: ts.Node) => {
          if (label) return;
          if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(propertyName(node.name) ?? '') && node.initializer &&
              ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText() === handlerName) {
            label = elementLabel(node.parent.parent as ts.JsxOpeningLikeElement);
          }
          ts.forEachChild(node, find);
        };
        if (scope) find(scope);
        if (label) return label;
      }
      if (ts.isFunctionDeclaration(current) || ts.isSourceFile(current)) return undefined;
    }
    return undefined;
  }

  function collectNavigation(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (isRouteTag(node)) return;
      for (const name of ['to', 'href', 'routerLink']) {
        const value = str(jsxAttributeValue(jsxAttribute(node, name)));
        const target = value ? toPath(value) : undefined;
        if (!target) continue;
        const element = ts.isJsxOpeningElement(node) ? node.parent : node;
        const label = str(jsxAttributeValue(jsxAttribute(node, 'aria-label'))) ?? str(jsxAttributeValue(jsxAttribute(node, 'title'))) ??
          str(jsxAttributeValue(jsxAttribute(node, 'label'))) ?? (ts.isJsxElement(element) ? textOfJsx(element) : undefined);
        rawLinks.push({ node, kind: 'link', target, label: label ? clean(label, 80) : undefined });
        break;
      }
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const owner = receiverText(node.expression);
      let kind: NavigationLink['kind'] | undefined;
      if (name === 'navigate' || name === 'navigateTo' || name === 'navigateByUrl') kind = 'navigate';
      else if ((name === 'push' || name === 'replace') && /(router|history|navigation|navigator)$/i.test(owner)) kind = 'navigate';
      else if (name === 'redirect' || name === 'permanentRedirect') kind = 'redirect';
      if (kind) {
        const first = node.arguments[0];
        let value = str(first);
        if (value === undefined && first && ts.isArrayLiteralExpression(unwrapExpression(first))) {
          value = joinRoute(...stringArray(first, resolveConstant).map(part => part.startsWith(':') ? PARAM : part));
        }
        if (value === undefined && first && ts.isObjectLiteralExpression(unwrapExpression(first))) {
          value = str(getProperty(unwrapExpression(first) as ts.ObjectLiteralExpression, 'pathname') ?? getProperty(unwrapExpression(first) as ts.ObjectLiteralExpression, 'path'));
        }
        const target = value ? toPath(value) : undefined;
        if (target) rawLinks.push({ node, kind, target, label: labelForCall(node) });
      }
      // Client HTTP requests (frontend -> backend).
      if (name === 'fetch' && !owner || name === 'fetch' && /^(window|globalThis|self)$/.test(owner)) {
        const url = str(node.arguments[0]);
        const target = url ? toPath(url) : undefined;
        const options = node.arguments[1] && ts.isObjectLiteralExpression(unwrapExpression(node.arguments[1])) ? unwrapExpression(node.arguments[1]) as ts.ObjectLiteralExpression : undefined;
        if (target) rawRequests.push({ node, method: (str(options ? getProperty(options, 'method') : undefined) ?? 'GET').toUpperCase(), target });
      } else if (name && HTTP_METHODS.has(name) && name !== 'all' && owner && node.arguments.length >= 1 &&
          !isHandlerLike(node.arguments[node.arguments.length - 1])) {
        const url = str(node.arguments[0]);
        const target = url ? toPath(url) : undefined;
        if (target && !/^(map|cache|params|searchParams|headers|store|storage|localStorage|sessionStorage|formData|url|query|req|request\.query)$/i.test(owner)) {
          rawRequests.push({ node, method: name.toUpperCase(), target });
        }
      }
    } else if (ts.isObjectLiteralExpression(node) && !isRouteObject(node)) {
      // Menu/sidebar configuration: { label: 'Orders', href: '/orders' }
      const targetKey = ['href', 'to', 'path', 'url', 'route', 'link'].find(key => getProperty(node, key) !== undefined);
      const labelKey = ['label', 'title', 'name', 'text'].find(key => getProperty(node, key) !== undefined);
      if (targetKey && labelKey && !getProperty(node, 'method') && !getProperty(node, 'handler')) {
        const value = str(getProperty(node, targetKey));
        const target = value ? toPath(value) : undefined;
        const labelExpression = getProperty(node, labelKey);
        let label = str(labelExpression);
        if (label === undefined && labelExpression && ts.isCallExpression(unwrapExpression(labelExpression))) {
          const key = str((unwrapExpression(labelExpression) as ts.CallExpression).arguments[0]);
          if (key) label = `{${key}}`;
        }
        if (target) rawLinks.push({ node, kind: 'menu', target, label: label ? clean(label, 80) : undefined });
      }
    }
  }

  // ---------- pass over source ----------
  for (const sourceFile of sourceFiles) {
    const file = toProjectPath(sourceFile.fileName);
    if (isTestPath(file)) continue;
    const dependencies = readDependencies(input.projectRoot, file, dependencyCache);
    for (const name of ['next', 'react', 'react-router', 'react-router-dom', '@tanstack/react-router', 'vue', 'vue-router', '@angular/core',
      'express', 'fastify', 'koa', '@koa/router', 'hono', '@nestjs/core', 'svelte', 'remix', '@remix-run/react']) {
      if (dependencies.has(name)) frameworks.add(name);
    }
    if (dependencies.has('next')) processNextFile(sourceFile, file);
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node) && isRouteObject(node)) {
        let parent: ts.Node | undefined = node.parent;
        let nested = false;
        while (parent && !ts.isSourceFile(parent)) {
          if (ts.isObjectLiteralExpression(parent) && isRouteObject(parent)) { nested = true; break; }
          parent = parent.parent;
        }
        if (!nested) processRouteObject(node, '', [], file);
      } else if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (isRouteTag(opening)) {
          let parent: ts.Node | undefined = node.parent;
          let nested = false;
          while (parent && !ts.isSourceFile(parent)) {
            if ((ts.isJsxElement(parent) && isRouteTag(parent.openingElement))) { nested = true; break; }
            parent = parent.parent;
          }
          if (!nested) processJsxRoute(node, '', [], file);
        }
      } else if (ts.isCallExpression(node)) {
        collectRouterCall(node);
      } else if (ts.isClassDeclaration(node)) {
        processNestController(node, file);
      }
      collectNavigation(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const registration of registrations) {
    const file = relativeOf(registration.node);
    const middlewareAccess: AccessHint[] = [];
    for (const middleware of registration.middleware) {
      const text = middleware.getText();
      if (GUARD_NAME.test(text) && text.length < 100) middlewareAccess.push({ kind: 'guard', value: text, file, line: lineOf(middleware) });
      if (ts.isCallExpression(unwrapExpression(middleware))) {
        for (const role of (unwrapExpression(middleware) as ts.CallExpression).arguments.flatMap(argument => stringArray(argument, resolveConstant))) {
          if (/^[\w:.-]{2,40}$/.test(role)) middlewareAccess.push({ kind: 'role', value: role, file, line: lineOf(middleware) });
        }
      }
    }
    for (const prefix of prefixesFor(registration.receiver)) {
      pending.push({ kind: 'api_endpoint', route: joinRoute(prefix, registration.route), method: registration.method, source: 'http-router',
        node: registration.node, entry: registration.handler, access: [...routerGuardsFor(registration.receiver), ...middlewareAccess], labels: [] });
    }
  }

  // ---------- build surfaces ----------
  const surfaces = new Map<string, Surface>();
  const surfaceRoots = new Map<string, ts.Node[]>();
  for (const item of pending) {
    const id = item.kind === 'ui_route' ? `ui:${item.route}` : `api:${item.method ?? 'ANY'} ${item.route}`;
    let entryEntityIds: string[] = [];
    let roots: ts.Node[] = [];
    let uiText: string[] = [];
    let textKeys: string[] = [];
    let entryName: string | undefined;
    const fromSymbol = (symbol: ts.Symbol) => {
      entryName = symbol.getName() === 'default' ? undefined : symbol.getName();
      const entity = symbolToEntity.get(symbol);
      if (entity) {
        const scanned = entityScans.get(entity.id);
        entryEntityIds = [entity.id];
        roots = scanned?.roots ?? [];
        uiText = scanned?.uiText ?? [];
        textKeys = scanned?.textKeys ?? [];
        return;
      }
      const body = declarationBody(symbol);
      if (body) {
        const scanned = scan(body);
        entryEntityIds = [...scanned.refs.keys()];
        ({ roots, uiText, textKeys } = scanned);
      }
    };
    if (item.entrySymbol) fromSymbol(item.entrySymbol);
    else if (item.entry) {
      const entry = item.entry;
      const symbol = ts.isIdentifier(entry) || ts.isPropertyAccessExpression(entry) ? symbolOf(entry) : undefined;
      if (symbol) fromSymbol(symbol);
      else {
        const scanned = scan(entry);
        entryEntityIds = [...scanned.refs.keys()];
        ({ roots, uiText, textKeys } = scanned);
        if (ts.isMethodDeclaration(entry) && ts.isClassDeclaration(entry.parent)) entryName = `${entry.parent.name?.text ?? 'Controller'}.${propertyName(entry.name)}`;
      }
    }
    // Visible text of the page components themselves (not of guard/wrapper components).
    for (const id of entryEntityIds) {
      const scanned = entityScans.get(id);
      const name = id.slice(id.lastIndexOf('#') + 1);
      if (!scanned || GUARD_NAME.test(name)) continue;
      uiText = [...uiText, ...scanned.uiText];
      textKeys = [...textKeys, ...scanned.textKeys];
    }
    const surface: Surface = surfaces.get(id) ?? {
      id, kind: item.kind, route: item.route, ...(item.method ? { method: item.method } : {}), source: item.source,
      file: relativeOf(item.node), line: ts.isSourceFile(item.node) ? 1 : lineOf(item.node),
      ...(entryName ? { entryName } : {}), entryEntityIds: [], access: [], uiText: [], textKeys: [], navigation: [],
    };
    surface.entryEntityIds = [...new Set([...surface.entryEntityIds, ...entryEntityIds])].sort();
    const accessKeys = new Set(surface.access.map(hint => `${hint.kind}|${hint.value}`));
    for (const hint of item.access) if (!accessKeys.has(`${hint.kind}|${hint.value}`)) { accessKeys.add(`${hint.kind}|${hint.value}`); surface.access.push(hint); }
    surface.uiText = [...new Set([...item.labels, ...surface.uiText, ...uiText])].slice(0, MAX_UI_TEXT);
    surface.textKeys = [...new Set([...surface.textKeys, ...textKeys])].slice(0, 40);
    surfaces.set(id, surface);
    surfaceRoots.set(id, [...(surfaceRoots.get(id) ?? []), ...roots]);
  }

  // Which AST roots (and therefore which links/requests) belong to which surface.
  const rootToSurfaces = new Map<ts.Node, Set<string>>();
  const addRoot = (node: ts.Node, surfaceId: string) => {
    if (!rootToSurfaces.has(node)) rootToSurfaces.set(node, new Set());
    rootToSurfaces.get(node)!.add(surfaceId);
  };
  for (const surface of surfaces.values()) {
    for (const root of surfaceRoots.get(surface.id) ?? []) addRoot(root, surface.id);
    if (surface.kind !== 'ui_route') continue;
    const seen = new Set<string>(surface.entryEntityIds);
    let frontier = [...surface.entryEntityIds];
    for (let depth = 0; depth < MAX_SURFACE_REACH_DEPTH && frontier.length; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const root of entityScans.get(id)?.roots ?? []) addRoot(root, surface.id);
        for (const target of forward.get(id) ?? []) if (!seen.has(target)) { seen.add(target); next.push(target); }
      }
      frontier = next;
    }
  }
  const owningSurfaces = (node: ts.Node): string[] => {
    const result = new Set<string>();
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      for (const id of rootToSurfaces.get(current) ?? []) result.add(id);
    }
    return [...result].sort();
  };
  const owningEntity = (node: ts.Node): string | undefined => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) && entityForDeclaration.has(current)) return entityForDeclaration.get(current)!.id;
    }
    return undefined;
  };
  const uiSurfaces = [...surfaces.values()].filter(surface => surface.kind === 'ui_route');
  const apiSurfaces = [...surfaces.values()].filter(surface => surface.kind === 'api_endpoint');
  const matchUi = (target: string) => {
    const matches = uiSurfaces.filter(surface => routeMatches(surface.route, target));
    const best = Math.min(...matches.map(surface => dynamicSegmentCount(surface.route)));
    return matches.filter(surface => dynamicSegmentCount(surface.route) === best).map(surface => surface.id).sort();
  };
  const matchApi = (target: string, method: string) => {
    const candidates = apiSurfaces.filter(surface => surface.method === 'ANY' || method === 'ANY' || surface.method === method);
    let matches = candidates.filter(surface => routeMatches(surface.route, target));
    if (!matches.length) {
      // Tolerate a single proxy prefix such as /api between client and server routes.
      const stripped = target.replace(/^\/[^/]+/, '') || '/';
      matches = candidates.filter(surface => routeMatches(surface.route, stripped) || routeMatches(surface.route.replace(/^\/[^/]+/, '') || '/', target));
    }
    return matches.map(surface => surface.id).sort();
  };

  const navigation: NavigationLink[] = [];
  const linkKeys = new Set<string>();
  for (const link of rawLinks) {
    const file = relativeOf(link.node);
    const line = lineOf(link.node);
    const key = `${file}:${line}:${link.target}`;
    if (linkKeys.has(key)) continue;
    linkKeys.add(key);
    const fromEntityId = owningEntity(link.node);
    navigation.push({ kind: link.kind, target: link.target, ...(link.label ? { label: link.label } : {}), file, line,
      ...(fromEntityId ? { fromEntityId } : {}), fromSurfaceIds: owningSurfaces(link.node), targetSurfaceIds: matchUi(link.target) });
  }
  for (const redirect of redirectLinks) {
    const target = toPath(redirect.target);
    if (!target) continue;
    navigation.push({ kind: 'redirect', target, file: relativeOf(redirect.node), line: lineOf(redirect.node),
      fromSurfaceIds: redirect.from ? matchUi(redirect.from) : [], targetSurfaceIds: matchUi(target) });
  }
  const requests: ClientRequest[] = rawRequests.map(request => {
    const fromEntityId = owningEntity(request.node);
    return { method: request.method, target: request.target, file: relativeOf(request.node), line: lineOf(request.node),
      ...(fromEntityId ? { fromEntityId } : {}), fromSurfaceIds: owningSurfaces(request.node), targetSurfaceIds: matchApi(request.target, request.method) };
  });

  computeNavigationPaths(uiSurfaces, navigation, surfaces);

  const e2eFlows = extractE2EFlows(sourceFiles, toProjectPath);
  for (const flow of e2eFlows) {
    const reached = new Set(flow.visitedRoutes.flatMap(route => matchUi(route)));
    // Clicking a link whose label is known follows that link's target.
    for (const step of flow.steps) {
      const label = /^Click the '(.+)' link$/.exec(step)?.[1];
      if (!label) continue;
      for (const link of navigation) if (link.label === label) for (const id of link.targetSurfaceIds) reached.add(id);
    }
    flow.surfaceIds = [...reached].sort();
  }

  // ---------- fingerprints ----------
  const sourceByFile = new Map(sourceFiles.map(sourceFile => [toProjectPath(sourceFile.fileName), sourceFile]));
  const entityFingerprints: Record<string, string> = {};
  for (const entity of input.entities) {
    const sourceFile = sourceByFile.get(entity.file);
    if (!sourceFile) continue;
    const lines = sourceFile.text.split('\n').slice(entity.startLine - 1, entity.endLine);
    entityFingerprints[entity.id] = fingerprintSource(lines.join('\n'));
  }

  const surfaceList = [...surfaces.values()].sort((a, b) => a.id.localeCompare(b.id));
  const hasJsx = sourceFiles.some(sourceFile => sourceFile.fileName.endsWith('.tsx'));
  return {
    schemaVersion: APPLICATION_MAP_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    headSha: input.headSha,
    platform: {
      frontend: uiSurfaces.length > 0 || hasJsx,
      backend: apiSurfaces.length > 0,
      frameworks: [...frameworks].sort(),
    },
    surfaces: surfaceList,
    navigation: navigation.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)),
    requests,
    e2eFlows,
    relations: supplemental,
    entityFingerprints,
    limitations: [...APPLICATION_MAP_LIMITATIONS],
  };
}

/**
 * Computes the shortest deterministic click path to each UI surface, starting from the root page
 * or from global navigation (links not owned by any surface, e.g. app-shell menus).
 */
function computeNavigationPaths(uiSurfaces: Surface[], links: NavigationLink[], surfaces: Map<string, Surface>): void {
  const usable = links.filter(link => link.kind !== 'redirect' && link.targetSurfaceIds.length);
  const labelOf = (link: NavigationLink) => link.label ? `'${link.label}'` : `the link to ${link.target}`;
  const stepFor = (link: NavigationLink) => link.kind === 'navigate'
    ? link.label ? `Complete '${link.label}', which continues to ${link.target}` : `Complete the page action that continues to ${link.target}`
    : `Select ${labelOf(link)}`;
  for (const surface of uiSurfaces) {
    const global = usable.find(link => !link.fromSurfaceIds.length && link.targetSurfaceIds.includes(surface.id));
    if (global) {
      surface.navigation = [`Use the application's main navigation and select ${labelOf(global)}`];
      continue;
    }
    // BFS backwards over links: which surfaces link to this one?
    const previous = new Map<string, { from: string; link: NavigationLink }>();
    const queue = [surface.id];
    const seen = new Set(queue);
    let start: string | undefined;
    let startLink: NavigationLink | undefined;
    while (queue.length && !start) {
      const current = queue.shift()!;
      for (const link of usable) {
        if (!link.targetSurfaceIds.includes(current)) continue;
        if (!link.fromSurfaceIds.length) { start = current; startLink = link; break; }
        for (const from of link.fromSurfaceIds) {
          if (seen.has(from)) continue;
          seen.add(from);
          previous.set(from, { from: current, link });
          queue.push(from);
          if (surfaces.get(from)?.route === '/' || !usable.some(other => other.targetSurfaceIds.includes(from))) { start = from; break; }
        }
        if (start) break;
      }
    }
    if (!start) continue;
    const steps: string[] = [];
    if (startLink) steps.push(`Use the application's main navigation and select ${labelOf(startLink)}`);
    else steps.push(`Open ${surfaces.get(start)?.route ?? '/'}`);
    for (let current = start; current !== surface.id;) {
      const hop = previous.get(current);
      if (!hop) break;
      steps.push(stepFor(hop.link));
      current = hop.from;
    }
    if (steps.length > 1 || startLink) surface.navigation = steps.slice(0, 6);
  }
}

/** Shortest dependency path from any entry entity of a surface to `entityId`, or undefined. */
export function findSurfacePath(map: ApplicationMap, relations: Relation[], surface: Surface, entityId: string,
  maxDepth = MAX_SURFACE_REACH_DEPTH): string[] | undefined {
  const forward = new Map<string, string[]>();
  for (const relation of [...relations, ...map.relations]) {
    if (!forward.has(relation.from)) forward.set(relation.from, []);
    forward.get(relation.from)!.push(relation.to);
  }
  const previous = new Map<string, string | null>();
  let frontier = surface.entryEntityIds.filter(id => !previous.has(id));
  for (const id of frontier) previous.set(id, null);
  for (let depth = 0; depth <= maxDepth && frontier.length; depth += 1) {
    if (previous.has(entityId)) break;
    const next: string[] = [];
    for (const id of frontier) for (const target of forward.get(id) ?? []) {
      if (!previous.has(target)) { previous.set(target, id); next.push(target); }
    }
    frontier = next;
  }
  if (!previous.has(entityId)) return undefined;
  const path: string[] = [];
  for (let current: string | null | undefined = entityId; current; current = previous.get(current)) path.unshift(current);
  return path;
}

/** Surfaces whose component/handler tree can reach the entity, nearest first. */
export function findSurfacesForEntity(map: ApplicationMap, relations: Relation[], entityId: string, limit = 8):
  Array<{ surface: Surface; path: string[] }> {
  const reverse = new Map<string, string[]>();
  for (const relation of [...relations, ...map.relations]) {
    if (!reverse.has(relation.to)) reverse.set(relation.to, []);
    reverse.get(relation.to)!.push(relation.from);
  }
  // Reverse BFS from the entity; any reached entity that is a surface entry maps to that surface.
  const next = new Map<string, string | null>([[entityId, null]]);
  let frontier = [entityId];
  const entryIndex = new Map<string, Surface[]>();
  for (const surface of map.surfaces) for (const id of surface.entryEntityIds) {
    if (!entryIndex.has(id)) entryIndex.set(id, []);
    entryIndex.get(id)!.push(surface);
  }
  const found: Array<{ surface: Surface; path: string[] }> = [];
  const seenSurfaces = new Set<string>();
  for (let depth = 0; depth <= MAX_SURFACE_REACH_DEPTH && frontier.length && found.length < limit; depth += 1) {
    const upcoming: string[] = [];
    for (const id of frontier) {
      for (const surface of entryIndex.get(id) ?? []) {
        if (seenSurfaces.has(surface.id)) continue;
        seenSurfaces.add(surface.id);
        const path: string[] = [];
        for (let current: string | null | undefined = id; current; current = next.get(current)) path.push(current);
        found.push({ surface, path });
      }
      for (const caller of reverse.get(id) ?? []) if (!next.has(caller)) { next.set(caller, id); upcoming.push(caller); }
    }
    frontier = upcoming;
  }
  return found.slice(0, limit);
}
