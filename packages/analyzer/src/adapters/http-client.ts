import * as ts from 'typescript';
import { PARAM, calleeName, getProperty, receiverText, toPath, unwrapExpression } from '../application-map-ast';
import { HTTP_METHODS } from './http-router/rules';
import { isHandlerLike } from './shared';
import type { AdapterContext } from './types';

export interface DetectedClientRequest { method: string; target: string }

const NOT_A_CLIENT = /^(map|cache|params|searchParams|headers|store|storage|localStorage|sessionStorage|formData|url|query|req|request\.query)$/i;
/** Receivers that are the HTTP library itself; any other receiver (`api.get`) is a project wrapper. */
const HTTP_LIBRARY = /^(axios|ky|got)$/;
const CLIENT_LIKE = /api|client|http|request|fetch|backend|service/i;

const isFetchCall = (name: string | undefined, owner: string): boolean =>
  name === 'fetch' && (!owner || /^(window|globalThis|self)$/.test(owner));
const isMethodCall = (ctx: AdapterContext, node: ts.CallExpression, name: string | undefined, owner: string): name is string =>
  !!name && HTTP_METHODS.has(name) && name !== 'all' && !!owner && node.arguments.length >= 1 &&
  !isHandlerLike(ctx, node.arguments[node.arguments.length - 1]!);

/** Client-side HTTP calls (frontend -> backend): `fetch(url, { method })` and `axios.get(url)` style calls. */
export function detectClientRequest(ctx: AdapterContext, node: ts.CallExpression): DetectedClientRequest | undefined {
  const name = calleeName(node.expression);
  const owner = receiverText(node.expression);
  if (isFetchCall(name, owner)) {
    const url = ctx.str(node.arguments[0]);
    const target = url ? toPath(url) : undefined;
    const options = node.arguments[1] && ts.isObjectLiteralExpression(unwrapExpression(node.arguments[1])) ? unwrapExpression(node.arguments[1]) as ts.ObjectLiteralExpression : undefined;
    if (target) return { method: (ctx.str(options ? getProperty(options, 'method') : undefined) ?? 'GET').toUpperCase(), target };
  } else if (isMethodCall(ctx, node, name, owner)) {
    const url = ctx.str(node.arguments[0]);
    const target = url ? toPath(url) : undefined;
    if (target && !NOT_A_CLIENT.test(owner)) {
      return { method: name.toUpperCase(), target };
    }
  }
  return undefined;
}

/** How the URL argument was written. `wrapper` is a literal URL passed to a project client (`api.get('/x')`). */
export type ClientRequestForm = 'literal' | 'template' | 'constant' | 'wrapper' | 'dynamic';

export interface ClassifiedClientRequest {
  node: ts.CallExpression;
  /** Upper-case; undefined when the method expression cannot be resolved. */
  method?: string;
  /** Normalized path (`:param` placeholders); undefined when the URL cannot be resolved. */
  target?: string;
  form: ClientRequestForm;
  /** True when the method is a literal (or the default GET), not a constant or variable. */
  methodLiteral: boolean;
}

const isStringLiteralLike = (expression: ts.Expression): boolean => {
  const target = unwrapExpression(expression);
  return ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target);
};
const isReference = (expression: ts.Expression): boolean => {
  const target = unwrapExpression(expression);
  return ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target);
};

function classifyUrl(ctx: AdapterContext, argument: ts.Expression | undefined): { target?: string; form: 'literal' | 'template' | 'constant' | 'dynamic' } {
  if (!argument) return { form: 'dynamic' };
  const expression = unwrapExpression(argument);
  const text = ctx.str(argument);
  const target = text !== undefined ? toPath(text) : undefined;
  if (!target) return { form: 'dynamic' };
  if (isStringLiteralLike(expression)) return { target, form: 'literal' };
  if (ts.isTemplateExpression(expression)) {
    const first = expression.templateSpans[0];
    return { target, form: expression.head.text === '' && first && ctx.str(first.expression) !== undefined ? 'constant' : 'template' };
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return { target, form: isReference(expression.left) ? 'constant' : text!.includes(PARAM) ? 'template' : 'literal' };
  }
  if (isReference(expression)) return { target, form: 'constant' };
  return { target, form: 'dynamic' };
}

/**
 * Like detectClientRequest, but also reports calls whose URL or method cannot be resolved and
 * says how the request was written. Kept separate so application-map output is unaffected.
 */
export function classifyClientRequest(ctx: AdapterContext, node: ts.CallExpression): ClassifiedClientRequest | undefined {
  const name = calleeName(node.expression);
  const owner = receiverText(node.expression);
  if (isFetchCall(name, owner)) {
    const url = classifyUrl(ctx, node.arguments[0]);
    const second = node.arguments[1] ? unwrapExpression(node.arguments[1]) : undefined;
    let method: string | undefined = 'GET';
    let methodLiteral = true;
    if (second && !ts.isObjectLiteralExpression(second)) { method = undefined; methodLiteral = false; }
    else if (second) {
      const expression = getProperty(second as ts.ObjectLiteralExpression, 'method');
      if (expression) {
        method = ctx.str(expression)?.toUpperCase();
        methodLiteral = method !== undefined && isStringLiteralLike(expression);
      } else if ((second as ts.ObjectLiteralExpression).properties.some(ts.isSpreadAssignment)) { method = undefined; methodLiteral = false; }
    }
    return { node, method, target: url.target, form: url.form, methodLiteral };
  }
  if (isMethodCall(ctx, node, name, owner) && !NOT_A_CLIENT.test(owner)) {
    const url = classifyUrl(ctx, node.arguments[0]);
    // `repo.get(id)` is not a request; an unresolved URL only counts on a client-looking receiver.
    if (url.form === 'dynamic' && !(HTTP_LIBRARY.test(owner) || CLIENT_LIKE.test(owner))) return undefined;
    const form = url.form === 'literal' && !HTTP_LIBRARY.test(owner) ? 'wrapper' : url.form;
    return { node, method: name.toUpperCase(), target: url.target, form, methodLiteral: true };
  }
  return undefined;
}
