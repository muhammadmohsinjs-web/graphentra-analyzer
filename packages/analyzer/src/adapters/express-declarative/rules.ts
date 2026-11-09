import * as ts from 'typescript';
import { GUARD_NAME, lineOf } from '../../application-map-ast';
import { isHandlerLike, receiverSymbol } from '../shared';
import type { RouterSink } from '../router-model';

export const ADAPTER_ID = 'express-declarative';

/**
 * Express route registration as data. Each rule says which method names it matches and where in
 * the call's argument list the path, handler, middleware, and mounted routers sit. The engine
 * below interprets them; adding another Express-shaped router means adding a rule, not code.
 */
export type ArgumentIndex = number | 'last';

export interface RouteRule {
  kind: 'route';
  /** Method names, e.g. get/post; `ANY` is reported for `anyMethod`. */
  methods: ReadonlySet<string>;
  anyMethod: string;
  minArguments: number;
  /** Path argument index; it must be a string starting with `/`. */
  path: number;
  handler: ArgumentIndex;
  /** Arguments between this index and the handler are middleware. */
  middlewareFrom: number;
}

export interface MountRule {
  kind: 'mount';
  method: string;
  /** Mount prefix argument index; it must be a string starting with `/`. */
  prefix: number;
  /** Arguments from this index on are mounted routers. */
  childrenFrom: number;
}

export interface GuardRule {
  kind: 'guard';
  method: string;
  /** Arguments whose source text matches the guard name pattern become router-level guards. */
  maxTextLength: number;
}

export type ExpressRule = RouteRule | MountRule | GuardRule;

export const EXPRESS_RULES: readonly ExpressRule[] = [
  {
    kind: 'route', methods: new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']), anyMethod: 'all',
    minArguments: 2, path: 0, handler: 'last', middlewareFrom: 1,
  },
  { kind: 'mount', method: 'use', prefix: 0, childrenFrom: 1 },
  { kind: 'guard', method: 'use', maxTextLength: 80 },
];

function argumentAt(call: ts.CallExpression, index: ArgumentIndex): ts.Expression | undefined {
  return index === 'last' ? call.arguments[call.arguments.length - 1] : call.arguments[index];
}

/** Interprets {@link EXPRESS_RULES} for one call expression; the first matching rule consumes it. */
export function collectExpressCall(sink: RouterSink, call: ts.CallExpression): void {
  const { ctx } = sink;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  for (const rule of EXPRESS_RULES) {
    if (rule.kind === 'route') {
      if (!rule.methods.has(method) || call.arguments.length < rule.minArguments) continue;
      const route = ctx.str(argumentAt(call, rule.path));
      if (route === undefined) continue; // chained `router.route('/x').get(...)` belongs to http-router
      const handler = argumentAt(call, rule.handler);
      if (route.startsWith('/') && handler && isHandlerLike(ctx, handler)) {
        sink.register({ adapterId: ADAPTER_ID, receiver: receiverSymbol(ctx, receiver), route, method: method === rule.anyMethod ? 'ANY' : method.toUpperCase(),
          handler, middleware: [...call.arguments.slice(rule.middlewareFrom, -1)], node: call });
      }
      return;
    }
    if (rule.method !== method) continue;
    if (rule.kind === 'mount') {
      const prefix = ctx.str(argumentAt(call, rule.prefix));
      if (!(prefix?.startsWith('/') && call.arguments[rule.childrenFrom])) continue;
      for (const child of call.arguments.slice(rule.childrenFrom)) {
        const symbol = receiverSymbol(ctx, child);
        if (symbol) sink.mount({ parent: receiverSymbol(ctx, receiver), child: symbol, prefix });
      }
      return;
    }
    const owner = receiverSymbol(ctx, receiver);
    for (const argument of call.arguments) {
      const name = argument.getText();
      if (owner && GUARD_NAME.test(name) && name.length < rule.maxTextLength) {
        sink.guard(owner, { kind: 'guard', value: name, file: ctx.relativeOf(call), line: lineOf(call) });
      }
    }
    return;
  }
}
