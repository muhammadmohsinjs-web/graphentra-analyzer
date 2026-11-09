import * as ts from 'typescript';
import type { AccessHint } from '../application-map';
import { GUARD_NAME, joinRoute, lineOf, stringArray, unwrapExpression } from '../application-map-ast';
import { collectExpressCall } from './express-declarative/rules';
import { collectGenericRouterCall } from './http-router/rules';
import type { AdapterContext, DetectedSurface } from './types';

/** One route registration (`router.get('/x', handler)` and friends) found by a router adapter. */
export interface Registration {
  adapterId: string;
  receiver?: ts.Symbol;
  route: string;
  method: string;
  handler: ts.Expression;
  middleware: ts.Expression[];
  node: ts.Node;
}
export interface Mount { parent?: ts.Symbol; child: ts.Symbol; prefix: string }

/** Where router collectors record what they find. */
export interface RouterSink {
  ctx: AdapterContext;
  register(registration: Registration): void;
  mount(mount: Mount): void;
  guard(owner: ts.Symbol, hint: AccessHint): void;
}

/**
 * Registrations, mounts, and router-level guards of every router-style adapter. Mount prefixes
 * resolve across adapters (an Express router can be mounted by a Fastify-style `register`), so the
 * model is collected once and each adapter then reads back its own registrations.
 */
export interface RouterModel {
  registrations: Registration[];
  mounts: Mount[];
  routerGuards: Map<ts.Symbol, AccessHint[]>;
}

export function routerModel(ctx: AdapterContext): RouterModel {
  return ctx.memo('router-model', () => {
    const model: RouterModel = { registrations: [], mounts: [], routerGuards: new Map() };
    const sink: RouterSink = {
      ctx,
      register: registration => { model.registrations.push(registration); },
      mount: mount => { model.mounts.push(mount); },
      guard: (owner, hint) => {
        if (!model.routerGuards.has(owner)) model.routerGuards.set(owner, []);
        model.routerGuards.get(owner)!.push(hint);
      },
    };
    for (const { sourceFile } of ctx.files) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          collectExpressCall(sink, node);
          collectGenericRouterCall(sink, node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return model;
  });
}

function prefixesFor(model: RouterModel, symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): string[] {
  if (!symbol || seen.has(symbol)) return [''];
  seen.add(symbol);
  const parents = model.mounts.filter(mount => mount.child === symbol);
  if (!parents.length) return [''];
  return parents.flatMap(mount => prefixesFor(model, mount.parent, seen).map(prefix => joinRoute(prefix, mount.prefix)));
}

function routerGuardsFor(model: RouterModel, symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): AccessHint[] {
  if (!symbol || seen.has(symbol)) return [];
  seen.add(symbol);
  return [...(model.routerGuards.get(symbol) ?? []), ...model.mounts.filter(mount => mount.child === symbol)
    .flatMap(mount => routerGuardsFor(model, mount.parent, seen))];
}

/** Turns the registrations owned by `adapterId` into surfaces, in global discovery order. */
export function routerSurfaces(ctx: AdapterContext, adapterId: string): DetectedSurface[] {
  const model = routerModel(ctx);
  const found: DetectedSurface[] = [];
  model.registrations.forEach((registration, sequence) => {
    if (registration.adapterId !== adapterId) return;
    const file = ctx.relativeOf(registration.node);
    const middlewareAccess: AccessHint[] = [];
    for (const middleware of registration.middleware) {
      const text = middleware.getText();
      if (GUARD_NAME.test(text) && text.length < 100) middlewareAccess.push({ kind: 'guard', value: text, file, line: lineOf(middleware) });
      if (ts.isCallExpression(unwrapExpression(middleware))) {
        for (const role of (unwrapExpression(middleware) as ts.CallExpression).arguments.flatMap(argument => stringArray(argument, ctx.resolveConstant))) {
          if (/^[\w:.-]{2,40}$/.test(role)) middlewareAccess.push({ kind: 'role', value: role, file, line: lineOf(middleware) });
        }
      }
    }
    for (const prefix of prefixesFor(model, registration.receiver)) {
      found.push({ kind: 'api_endpoint', route: joinRoute(prefix, registration.route), method: registration.method, source: 'http-router',
        node: registration.node, entry: registration.handler, access: [...routerGuardsFor(model, registration.receiver), ...middlewareAccess],
        labels: [], order: [1, sequence, 0] });
    }
  });
  return found;
}
