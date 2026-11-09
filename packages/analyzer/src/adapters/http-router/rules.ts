import * as ts from 'typescript';
import { calleeName, getProperty, stringArray, unwrapExpression } from '../../application-map-ast';
import { isHandlerLike, receiverSymbol } from '../shared';
import type { RouterSink } from '../router-model';

export const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

export const ADAPTER_ID = 'http-router';

/**
 * Router forms that are not plain `receiver.verb('/path', handler)` calls: Fastify/Hono-style
 * `register(plugin, { prefix })`, `route({ method, url, handler })`, and the chained
 * `router.route('/path').verb(handler)`.
 */
export function collectGenericRouterCall(sink: RouterSink, call: ts.CallExpression): void {
  const { ctx } = sink;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  if (method === 'register') {
    const [first, second] = call.arguments;
    if (!first) return;
    const options = second && ts.isObjectLiteralExpression(unwrapExpression(second)) ? unwrapExpression(second) as ts.ObjectLiteralExpression : undefined;
    const registered = ctx.str(options ? getProperty(options, 'prefix') : undefined);
    const symbol = receiverSymbol(ctx, first);
    if (symbol && registered) sink.mount({ parent: receiverSymbol(ctx, receiver), child: symbol, prefix: registered });
    return;
  }
  if (method === 'route' && call.arguments.length === 1) {
    const options = unwrapExpression(call.arguments[0]!);
    if (ts.isObjectLiteralExpression(options)) {
      const url = ctx.str(getProperty(options, 'url') ?? getProperty(options, 'path'));
      const handler = getProperty(options, 'handler');
      if (url?.startsWith('/') && handler) {
        for (const verb of stringArray(getProperty(options, 'method'), ctx.resolveConstant)) {
          sink.register({ adapterId: ADAPTER_ID, receiver: receiverSymbol(ctx, receiver), route: url, method: verb.toUpperCase(), handler, middleware: [], node: call });
        }
      }
    }
    return;
  }
  if (!HTTP_METHODS.has(method) || call.arguments.length < 2) return;
  // router.route('/orders').get(handler)
  if (ctx.str(call.arguments[0]) !== undefined) return;
  const chained = unwrapExpression(receiver);
  if (!(ts.isCallExpression(chained) && calleeName(chained.expression) === 'route' && ts.isPropertyAccessExpression(chained.expression))) return;
  const route = ctx.str(chained.arguments[0]);
  const owner = chained.expression.expression;
  const handler = call.arguments[call.arguments.length - 1];
  if (route?.startsWith('/') && isHandlerLike(ctx, handler)) {
    sink.register({ adapterId: ADAPTER_ID, receiver: receiverSymbol(ctx, owner), route, method: method === 'all' ? 'ANY' : method.toUpperCase(), handler: handler!,
      middleware: [...call.arguments.slice(0, -1)], node: call });
  }
}
