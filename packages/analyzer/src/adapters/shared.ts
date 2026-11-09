import * as ts from 'typescript';
import type { AccessHint } from '../application-map';
import {
  GUARD_NAME, calleeName, clean, getProperty, hasProperty, isFunctionLike, lineOf, propertyName, stringArray, unwrapExpression,
} from '../application-map-ast';
import type { AdapterContext } from './types';

export const ROUTE_ENTRY_KEYS = ['element', 'component', 'Component', 'loadComponent', 'lazy', 'page'];
export const ROUTE_KEYS = [...ROUTE_ENTRY_KEYS, 'children', 'redirectTo', 'loader', 'index'];

// Access hints and route-object helpers shared by the route-config and react-router adapters
// (and by the host's navigation pass).
export function guardHintsFromExpression(ctx: AdapterContext, expression: ts.Node, file: string, hints: AccessHint[]): void {
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if (GUARD_NAME.test(tag)) hints.push({ kind: 'guard', value: tag, file, line: lineOf(node) });
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
        const name = propertyName(attribute.name) ?? '';
        if (/^(roles?|allowedRoles|permissions?|requiredRole|scopes?)$/i.test(name)) {
          const value = ts.isStringLiteral(attribute.initializer) ? [attribute.initializer.text]
            : stringArray((attribute.initializer as ts.JsxExpression).expression, ctx.resolveConstant);
          for (const role of value) hints.push({ kind: 'role', value: role, file, line: lineOf(attribute) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
}

export function guardHintsFromObject(ctx: AdapterContext, object: ts.ObjectLiteralExpression, file: string): AccessHint[] {
  const hints: AccessHint[] = [];
  const visit = (literal: ts.ObjectLiteralExpression) => {
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name) ?? '';
      const value = unwrapExpression(property.initializer);
      if (/^(meta|data|handle)$/.test(name) && ts.isObjectLiteralExpression(value)) { visit(value); continue; }
      if (/^(canActivate|canActivateChild|canLoad|canMatch|guards?|middleware|beforeEnter)$/i.test(name)) {
        for (const guard of stringArray(value, ctx.resolveConstant)) hints.push({ kind: 'guard', value: guard, file, line: lineOf(property) });
        if (!ts.isArrayLiteralExpression(value)) hints.push({ kind: 'guard', value: value.getText().slice(0, 60), file, line: lineOf(property) });
      } else if (/^(roles?|allowedRoles|permissions?|requiredRoles?|scopes?)$/i.test(name)) {
        for (const role of stringArray(value, ctx.resolveConstant)) hints.push({ kind: 'role', value: role, file, line: lineOf(property) });
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

export function routeLabels(ctx: AdapterContext, object: ts.ObjectLiteralExpression): string[] {
  const labels: string[] = [];
  const visit = (literal: ts.ObjectLiteralExpression) => {
    for (const key of ['title', 'name', 'label', 'breadcrumb']) {
      const value = ctx.str(getProperty(literal, key));
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

export function isRouteObject(ctx: AdapterContext, node: ts.Node): node is ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const pathValue = getProperty(node, 'path');
  const hasPath = pathValue !== undefined && ctx.str(pathValue) !== undefined;
  const isIndex = getProperty(node, 'index')?.kind === ts.SyntaxKind.TrueKeyword;
  return (hasPath || isIndex) && hasProperty(node, ROUTE_KEYS) && !getProperty(node, 'method') && !getProperty(node, 'url');
}

export function jsxAttribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find((property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && propertyName(property.name) === name);
}
export function jsxAttributeValue(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
  if (!attribute?.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
  if (ts.isJsxExpression(attribute.initializer)) return attribute.initializer.expression;
  return undefined;
}
export const isRouteTag = (element: ts.JsxOpeningLikeElement) => /(^|\.)(\w*Route)$/.test(element.tagName.getText()) &&
  !/Routes$/.test(element.tagName.getText());

export function isHandlerLike(ctx: AdapterContext, expression: ts.Expression | undefined, depth = 0): boolean {
  if (!expression || depth > 3) return false;
  const target = unwrapExpression(expression);
  if (isFunctionLike(target)) return true;
  if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) {
    const symbol = ctx.symbolOf(target);
    if (!symbol) return false;
    if (ctx.symbolToEntity.has(symbol)) return true;
    const body = ctx.declarationBody(symbol);
    return Boolean(body && (isFunctionLike(body) || ts.isFunctionDeclaration(body) || ts.isMethodDeclaration(body)));
  }
  if (ts.isCallExpression(target)) {
    const name = calleeName(target.expression);
    if (name === 'bind' && ts.isPropertyAccessExpression(target.expression)) return isHandlerLike(ctx, target.expression.expression, depth + 1);
    return target.arguments.some(argument => isHandlerLike(ctx, argument, depth + 1));
  }
  return false;
}

export function receiverSymbol(ctx: AdapterContext, expression: ts.Expression): ts.Symbol | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) return ctx.symbolOf(target);
  return undefined;
}
