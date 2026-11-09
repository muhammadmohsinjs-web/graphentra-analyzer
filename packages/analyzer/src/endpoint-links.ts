import * as ts from 'typescript';
import { routeMatches } from './application-map-ast';
import { classifyClientRequest, type ClientRequestForm } from './adapters/http-client';
import type { AdapterContext } from './adapters/types';
import type { EdgeConfidence, FrontierItem, SurfaceEdge, SurfaceNode } from './contracts';
import { compareStrings } from './deterministic';

/** A frontend HTTP call site attributed to the entity that contains it. */
export interface ClientCall {
  entityId: string;
  file: string;
  line: number;
  /** Upper-case; absent when the method cannot be resolved. */
  method?: string;
  /** Normalized path with `:param` placeholders; absent when the URL cannot be resolved. */
  target?: string;
  form: ClientRequestForm;
  methodLiteral: boolean;
}

export interface EndpointLinks {
  edges: SurfaceEdge[];
  frontier: FrontierItem[];
}

const ANY_METHOD = new Set(['ALL', 'ANY', '*']);

/** Compares route shapes ignoring parameter names, so `/a/:id` and `/a/[id]` are equal to `/a/:param`. */
const sameRoute = (route: string, target: string): boolean => route.replace(/\/+$/, '') === target.replace(/\/+$/, '');

/**
 * Links client calls to api surfaces (D9): a literal URL and literal method matching exactly one endpoint
 * is `proven`; template, parameter match, wrapper, constant URL, unknown method or several matches is
 * `likely` (one edge per match); an unresolvable URL becomes a `dynamic_endpoint_url` frontier item.
 * A resolved call that matches nothing is an external API and yields nothing.
 */
export function linkEndpoints(calls: ClientCall[], surfaces: SurfaceNode[]): EndpointLinks {
  const apis = surfaces.filter(surface => surface.kind === 'api_endpoint');
  const edges = new Map<string, SurfaceEdge>();
  const frontier = new Map<string, FrontierItem>();

  for (const call of calls) {
    if (call.target === undefined) {
      const item: FrontierItem = { entityId: call.entityId, file: call.file, line: call.line, reason: 'dynamic_endpoint_url' };
      frontier.set(`${item.entityId}|${item.file}|${item.line}`, item);
      continue;
    }
    const target = call.target;
    const matches = apis.filter(surface =>
      (call.method === undefined || surface.method === undefined || ANY_METHOD.has(surface.method.toUpperCase()) || surface.method.toUpperCase() === call.method) &&
      routeMatches(surface.route, target));
    for (const surface of matches) {
      const exact = matches.length === 1 && call.form === 'literal' && call.methodLiteral && call.method !== undefined &&
        surface.method !== undefined && !ANY_METHOD.has(surface.method.toUpperCase()) && sameRoute(surface.route, target);
      const confidence: EdgeConfidence = exact ? 'proven' : 'likely';
      const key = `${call.entityId}|CALLS_ENDPOINT|${surface.id}`;
      const existing = edges.get(key);
      if (!existing || existing.confidence === 'likely' && confidence === 'proven') {
        edges.set(key, { from: call.entityId, to: surface.id, type: 'CALLS_ENDPOINT', confidence });
      }
    }
  }

  return {
    edges: [...edges.values()].sort((a, b) => compareStrings(`${a.from}|${a.type}|${a.to}`, `${b.from}|${b.type}|${b.to}`)),
    frontier: [...frontier.values()].sort((a, b) => compareStrings(a.entityId, b.entityId) || compareStrings(a.file, b.file) || a.line - b.line),
  };
}

/**
 * Collects client calls from analyzed source files, attributing each to the nearest enclosing entity
 * declaration. Calls outside any entity (module top level) are skipped; the caller can report them.
 */
export function collectClientCalls(ctx: AdapterContext): ClientCall[] {
  const calls: ClientCall[] = [];
  for (const { sourceFile, file } of ctx.files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const request = classifyClientRequest(ctx, node);
        const entity = request ? enclosingEntity(ctx, node) : undefined;
        if (request && entity) {
          calls.push({
            entityId: entity.id, file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            method: request.method, target: request.target, form: request.form, methodLiteral: request.methodLiteral,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

function enclosingEntity(ctx: AdapterContext, node: ts.Node) {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const entity = ctx.entityForDeclaration.get(current);
    if (entity) return entity;
  }
  return undefined;
}
