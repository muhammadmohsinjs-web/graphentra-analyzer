import * as ts from 'typescript';
import type { AccessHint } from '../../application-map';
import { GUARD_NAME, calleeName, getProperty, joinRoute, lineOf, stringArray, unwrapExpression } from '../../application-map-ast';
import { ADAPTER_VERSION, detectSyntactic, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';

const NEST_METHODS = new Map([['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'], ['Delete', 'DELETE'], ['All', 'ANY'], ['Options', 'OPTIONS'], ['Head', 'HEAD']]);

function decorators(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}
function decoratorCall(decorator: ts.Decorator): { name?: string; args: readonly ts.Expression[] } {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression)) return { name: calleeName(expression.expression), args: expression.arguments };
  return { name: calleeName(expression), args: [] };
}
function nestAccess(ctx: AdapterContext, node: ts.Node, file: string): AccessHint[] {
  const hints: AccessHint[] = [];
  for (const decorator of decorators(node)) {
    const { name, args } = decoratorCall(decorator);
    if (!name) continue;
    if (name === 'UseGuards') for (const argument of args) hints.push({ kind: 'guard', value: argument.getText(), file, line: lineOf(decorator) });
    else if (/^(Roles|Permissions|RequirePermissions|RequireRoles|Scopes)$/.test(name)) for (const value of args.flatMap(arg => stringArray(arg, ctx.resolveConstant))) hints.push({ kind: 'role', value, file, line: lineOf(decorator) });
    else if (/^(Public|AllowAnonymous|SkipAuth)$/.test(name)) hints.push({ kind: 'public', value: name, file, line: lineOf(decorator) });
    else if (GUARD_NAME.test(name)) hints.push({ kind: 'guard', value: name, file, line: lineOf(decorator) });
  }
  return hints;
}
function processNestController(ctx: AdapterContext, declaration: ts.ClassDeclaration, file: string, order: readonly number[], found: DetectedSurface[]): void {
  const controller = decorators(declaration).map(decoratorCall).find(item => item.name === 'Controller');
  if (!controller) return;
  ctx.frameworks.add('nestjs');
  const first = controller.args[0];
  const prefix = first && ts.isObjectLiteralExpression(unwrapExpression(first))
    ? ctx.str(getProperty(unwrapExpression(first) as ts.ObjectLiteralExpression, 'path')) : ctx.str(first);
  const classAccess = nestAccess(ctx, declaration, file);
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    for (const decorator of decorators(member)) {
      const { name, args } = decoratorCall(decorator);
      const method = name ? NEST_METHODS.get(name) : undefined;
      if (!method) continue;
      const sub = args[0] && ts.isArrayLiteralExpression(unwrapExpression(args[0])) ? stringArray(args[0], ctx.resolveConstant) : [ctx.str(args[0]) ?? ''];
      for (const route of sub) {
        found.push({ kind: 'api_endpoint', route: joinRoute(prefix ?? '', route), method, source: 'nestjs', node: member, entry: member,
          access: [...classAccess, ...nestAccess(ctx, member, file)], labels: [], order });
      }
    }
  }
}

/** NestJS `@Controller` classes with HTTP-method decorators. */
export const nestjsAdapter: FrameworkAdapter = {
  id: 'nestjs',
  version: ADAPTER_VERSION,
  frameworks: ['@nestjs/core'],
  detect: () => detectSyntactic(),
  surfaces(ctx: AdapterContext): DetectedSurface[] {
    const found: DetectedSurface[] = [];
    for (const { sourceFile, file, index } of ctx.files) {
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) processNestController(ctx, node, file, [0, index, node.pos], found);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return found;
  },
};
