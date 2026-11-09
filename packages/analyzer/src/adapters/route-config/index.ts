import * as ts from 'typescript';
import type { AccessHint } from '../../application-map';
import { getProperty, joinRoute, unwrapExpression } from '../../application-map-ast';
import { ROUTE_ENTRY_KEYS, guardHintsFromExpression, guardHintsFromObject, isRouteObject, routeLabels } from '../shared';
import { ADAPTER_VERSION, detectSyntactic, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';

function processRouteObject(ctx: AdapterContext, object: ts.ObjectLiteralExpression, prefix: string, inherited: AccessHint[], file: string,
  order: readonly number[], found: DetectedSurface[]): void {
  const raw = ctx.str(getProperty(object, 'path'));
  const route = raw !== undefined && raw.startsWith('/') ? joinRoute(raw) : joinRoute(prefix, raw ?? '');
  const access = [...inherited, ...guardHintsFromObject(ctx, object, file)];
  const redirect = ctx.str(getProperty(object, 'redirectTo'));
  const entryKey = ROUTE_ENTRY_KEYS.find(key => getProperty(object, key) !== undefined);
  if (entryKey && !redirect) {
    const entry = getProperty(object, entryKey)!;
    guardHintsFromExpression(ctx, entry, file, access);
    found.push({ kind: 'ui_route', route, source: 'route-config', node: object, entry, access, labels: routeLabels(ctx, object), order });
  }
  if (redirect) ctx.redirectLinks.push({ node: object, target: redirect.startsWith('/') ? redirect : joinRoute(prefix, redirect), from: route });
  for (const key of ['children', 'routes']) {
    const children = getProperty(object, key);
    const list = children ? unwrapExpression(children) : undefined;
    if (list && ts.isArrayLiteralExpression(list)) {
      for (const child of list.elements) if (isRouteObject(ctx, unwrapExpression(child as ts.Expression))) {
        processRouteObject(ctx, unwrapExpression(child as ts.Expression) as ts.ObjectLiteralExpression, route, access, file, order, found);
      }
    }
  }
}

/** React Router / Vue Router / Angular style route configuration objects. */
export const routeConfigAdapter: FrameworkAdapter = {
  id: 'route-config',
  version: ADAPTER_VERSION,
  frameworks: ['react-router', 'react-router-dom', '@tanstack/react-router', 'vue-router', '@angular/core', 'remix', '@remix-run/react'],
  detect: () => detectSyntactic(),
  surfaces(ctx: AdapterContext): DetectedSurface[] {
    const found: DetectedSurface[] = [];
    for (const { sourceFile, file, index } of ctx.files) {
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node) && isRouteObject(ctx, node)) {
          let parent: ts.Node | undefined = node.parent;
          let nested = false;
          while (parent && !ts.isSourceFile(parent)) {
            if (ts.isObjectLiteralExpression(parent) && isRouteObject(ctx, parent)) { nested = true; break; }
            parent = parent.parent;
          }
          if (!nested) processRouteObject(ctx, node, '', [], file, [0, index, node.pos], found);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return found;
  },
};
