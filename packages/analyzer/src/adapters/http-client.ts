import * as ts from 'typescript';
import { calleeName, getProperty, receiverText, toPath, unwrapExpression } from '../application-map-ast';
import { HTTP_METHODS } from './http-router/rules';
import { isHandlerLike } from './shared';
import type { AdapterContext } from './types';

export interface DetectedClientRequest { method: string; target: string }

/** Client-side HTTP calls (frontend -> backend): `fetch(url, { method })` and `axios.get(url)` style calls. */
export function detectClientRequest(ctx: AdapterContext, node: ts.CallExpression): DetectedClientRequest | undefined {
  const name = calleeName(node.expression);
  const owner = receiverText(node.expression);
  if (name === 'fetch' && !owner || name === 'fetch' && /^(window|globalThis|self)$/.test(owner)) {
    const url = ctx.str(node.arguments[0]);
    const target = url ? toPath(url) : undefined;
    const options = node.arguments[1] && ts.isObjectLiteralExpression(unwrapExpression(node.arguments[1])) ? unwrapExpression(node.arguments[1]) as ts.ObjectLiteralExpression : undefined;
    if (target) return { method: (ctx.str(options ? getProperty(options, 'method') : undefined) ?? 'GET').toUpperCase(), target };
  } else if (name && HTTP_METHODS.has(name) && name !== 'all' && owner && node.arguments.length >= 1 &&
      !isHandlerLike(ctx, node.arguments[node.arguments.length - 1])) {
    const url = ctx.str(node.arguments[0]);
    const target = url ? toPath(url) : undefined;
    if (target && !/^(map|cache|params|searchParams|headers|store|storage|localStorage|sessionStorage|formData|url|query|req|request\.query)$/i.test(owner)) {
      return { method: name.toUpperCase(), target };
    }
  }
  return undefined;
}
