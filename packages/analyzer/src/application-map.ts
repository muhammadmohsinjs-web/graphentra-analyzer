import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { ANALYZER_VERSION, type Entity, type Relation } from './contracts';
import {
  PARAM, calleeName, clean, dynamicSegmentCount, getProperty, isFunctionLike, joinRoute, lineOf, propertyName, receiverText,
  routeMatches, stringArray, toPath, unwrapExpression, GUARD_NAME,
} from './application-map-ast';
import { extractE2EFlows, type E2EFlow } from './application-map-e2e';
import { createAdapterContext } from './adapters/context';
import { detectClientRequest } from './adapters/http-client';
import { ADAPTERS } from './adapters/registry';
import { isRouteObject, isRouteTag, jsxAttribute, jsxAttributeValue } from './adapters/shared';
import { compareOrder, type DetectedSurface, type FrameworkAdapter } from './adapters/types';
import { compareStrings } from './deterministic';

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


interface ScanResult {
  refs: Map<string, SupplementalRelation['type']>;
  roots: ts.Node[];
  uiText: string[];
  textKeys: string[];
}


export function fingerprintSource(text: string): string {
  const normalized = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim()).join('\n');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Which adapter (and adapter version) discovered each surface, keyed by surface id. Kept out of the map JSON. */
export type SurfaceProvenance = Map<string, { adapterId: string; adapterVersion: string }>;

export function extractApplicationMap(input: ExtractApplicationMapInput): ApplicationMap {
  return extractApplicationMapWithProvenance(input).map;
}

export function extractApplicationMapWithProvenance(input: ExtractApplicationMapInput): { map: ApplicationMap; provenance: SurfaceProvenance } {
  const { symbolToEntity, toProjectPath } = input;
  const ctx = createAdapterContext(input);
  const { sourceFiles, relativeOf, entityDeclaration, entityForDeclaration, resolve, symbolOf, declarationBody, resolveConstant, str, moduleDefault } = ctx;

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
  supplemental.sort((a, b) => compareStrings(`${a.from}|${a.to}`, `${b.from}|${b.to}`));
  const forward = new Map<string, Set<string>>();
  for (const relation of [...input.relations, ...supplemental]) {
    if (!forward.has(relation.from)) forward.set(relation.from, new Set());
    forward.get(relation.from)!.add(relation.to);
  }

  // ---------- surface discovery (one adapter per framework) ----------
  const frameworks = ctx.frameworks;
  for (const { dependencies } of ctx.files) {
    for (const name of ['next', 'react', 'react-router', 'react-router-dom', '@tanstack/react-router', 'vue', 'vue-router', '@angular/core',
      'express', 'fastify', 'koa', '@koa/router', 'hono', '@nestjs/core', 'svelte', 'remix', '@remix-run/react']) {
      if (dependencies.has(name)) frameworks.add(name);
    }
  }
  const discovered: Array<{ surface: DetectedSurface; adapter: FrameworkAdapter }> = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.detect(ctx).present) continue;
    for (const surface of adapter.surfaces(ctx)) discovered.push({ surface, adapter });
  }
  // Stable sort: merging same-id surfaces depends on discovery order (file, then source position).
  discovered.sort((a, b) => compareOrder(a.surface.order, b.surface.order));
  const redirectLinks = ctx.redirectLinks;
  const provenance: SurfaceProvenance = new Map();

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
      const request = detectClientRequest(ctx, node);
      if (request) rawRequests.push({ node, ...request });
    } else if (ts.isObjectLiteralExpression(node) && !isRouteObject(ctx, node)) {
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
  for (const { sourceFile } of ctx.files) {
    const visit = (node: ts.Node) => {
      collectNavigation(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // ---------- build surfaces ----------
  const surfaces = new Map<string, Surface>();
  const surfaceRoots = new Map<string, ts.Node[]>();
  for (const { surface: item, adapter } of discovered) {
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
    if (!provenance.has(id)) provenance.set(id, { adapterId: adapter.id, adapterVersion: adapter.version });
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

  const surfaceList = [...surfaces.values()].sort((a, b) => compareStrings(a.id, b.id));
  const hasJsx = sourceFiles.some(sourceFile => sourceFile.fileName.endsWith('.tsx'));
  const map: ApplicationMap = {
    schemaVersion: APPLICATION_MAP_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    headSha: input.headSha,
    platform: {
      frontend: uiSurfaces.length > 0 || hasJsx,
      backend: apiSurfaces.length > 0,
      frameworks: [...frameworks].sort(),
    },
    surfaces: surfaceList,
    navigation: navigation.sort((a, b) => compareStrings(`${a.file}:${a.line}`, `${b.file}:${b.line}`)),
    requests,
    e2eFlows,
    relations: supplemental,
    entityFingerprints,
    limitations: [...APPLICATION_MAP_LIMITATIONS],
  };
  return { map, provenance };
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