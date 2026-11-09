import * as ts from 'typescript';
import type { AccessHint } from '../../application-map';
import { GUARD_NAME, joinRoute, lineOf } from '../../application-map-ast';
import { guardHintsFromExpression, isRouteTag, jsxAttribute, jsxAttributeValue } from '../shared';
import { ADAPTER_VERSION, detectSyntactic, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';

function processJsxRoute(ctx: AdapterContext, element: ts.JsxElement | ts.JsxSelfClosingElement, prefix: string, inherited: AccessHint[], file: string,
  order: readonly number[], found: DetectedSurface[]): void {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const raw = ctx.str(jsxAttributeValue(jsxAttribute(opening, 'path')));
  const route = raw !== undefined && raw.startsWith('/') ? joinRoute(raw) : joinRoute(prefix, raw ?? '');
  const access = [...inherited];
  const tag = opening.tagName.getText();
  if (GUARD_NAME.test(tag)) access.push({ kind: 'guard', value: tag, file, line: lineOf(opening) });
  guardHintsFromExpression(ctx, opening, file, access);
  const entry = ['element', 'component', 'Component', 'render'].map(name => jsxAttributeValue(jsxAttribute(opening, name))).find(Boolean);
  if (entry) {
    guardHintsFromExpression(ctx, entry, file, access);
    found.push({ kind: 'ui_route', route, source: 'jsx-route', node: opening, entry, access, labels: [], order });
  }
  if (ts.isJsxElement(element)) {
    const visitChildren = (node: ts.Node) => {
      for (const child of (node as ts.JsxElement).children ?? []) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          const childOpening = ts.isJsxElement(child) ? child.openingElement : child;
          if (isRouteTag(childOpening)) processJsxRoute(ctx, child, route, access, file, order, found);
          else if (ts.isJsxElement(child)) visitChildren(child);
        }
      }
    };
    visitChildren(element);
  }
}

/** JSX `<Route path element>` trees (React Router and look-alikes). */
export const reactRouterAdapter: FrameworkAdapter = {
  id: 'react-router',
  version: ADAPTER_VERSION,
  frameworks: ['react-router', 'react-router-dom', '@tanstack/react-router'],
  detect: () => detectSyntactic(),
  surfaces(ctx: AdapterContext): DetectedSurface[] {
    const found: DetectedSurface[] = [];
    for (const { sourceFile, file, index } of ctx.files) {
      const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
          const opening = ts.isJsxElement(node) ? node.openingElement : node;
          if (isRouteTag(opening)) {
            let parent: ts.Node | undefined = node.parent;
            let nested = false;
            while (parent && !ts.isSourceFile(parent)) {
              if (ts.isJsxElement(parent) && isRouteTag(parent.openingElement)) { nested = true; break; }
              parent = parent.parent;
            }
            if (!nested) processJsxRoute(ctx, node, '', [], file, [0, index, node.pos], found);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return found;
  },
};
