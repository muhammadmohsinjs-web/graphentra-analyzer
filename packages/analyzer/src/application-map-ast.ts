import * as ts from 'typescript';

/** Placeholder used for dynamic route/URL segments discovered in template literals. */
export const PARAM = ':param';

export function lineOf(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function propertyName(name: ts.PropertyName | ts.JsxAttributeName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return undefined;
}

/** Name of the called function/method: `a.b.c()` -> `c`, `f()` -> `f`. */
export function calleeName(expression: ts.Expression): string | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

/** Receiver text of a property-access callee: `this.router.navigate` -> `this.router`. */
export function receiverText(expression: ts.Expression): string {
  const target = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(target)) return target.expression.getText();
  return '';
}

export function getProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
    if (ts.isMethodDeclaration(property) && propertyName(property.name) === name) return property as unknown as ts.Expression;
  }
  return undefined;
}

export function hasProperty(object: ts.ObjectLiteralExpression, names: string[]): boolean {
  return object.properties.some(property => {
    const name = 'name' in property ? propertyName(property.name as ts.PropertyName) : undefined;
    return name !== undefined && names.includes(name);
  });
}

/**
 * Evaluates simple string-valued expressions: literals, templates (dynamic parts become
 * `:param`), concatenation, and references to constant strings (depth-limited).
 */
export function stringValue(
  expression: ts.Expression | undefined,
  resolveConstant?: (identifier: ts.Expression) => ts.Expression | undefined,
  depth = 0,
): string | undefined {
  if (!expression || depth > 4) return undefined;
  const target = unwrapExpression(expression);
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return target.text;
  if (ts.isTemplateExpression(target)) {
    let text = target.head.text;
    for (const span of target.templateSpans) {
      text += stringValue(span.expression, resolveConstant, depth + 1) ?? PARAM;
      text += span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValue(target.left, resolveConstant, depth + 1);
    const right = stringValue(target.right, resolveConstant, depth + 1);
    if (left === undefined && right === undefined) return undefined;
    return `${left ?? PARAM}${right ?? PARAM}`;
  }
  if (resolveConstant && (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
    const resolved = resolveConstant(target);
    if (resolved && resolved !== target) return stringValue(resolved, resolveConstant, depth + 1);
  }
  return undefined;
}

export function stringArray(expression: ts.Expression | undefined, resolveConstant?: (e: ts.Expression) => ts.Expression | undefined): string[] {
  if (!expression) return [];
  const target = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap(element => {
      const value = stringValue(element as ts.Expression, resolveConstant);
      if (value !== undefined) return [value];
      return ts.isIdentifier(element) || ts.isPropertyAccessExpression(element) ? [element.getText()] : [];
    });
  }
  const single = stringValue(target, resolveConstant);
  return single !== undefined ? [single] : [];
}

/** Joins route segments into a normalized absolute path. */
export function joinRoute(...parts: Array<string | undefined>): string {
  const segments = parts
    .filter((part): part is string => typeof part === 'string')
    .flatMap(part => part.split('/'))
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.');
  return `/${segments.join('/')}`;
}

/** Strips origin, query string, and hash from a URL or path; returns undefined for non-paths. */
export function toPath(value: string): string | undefined {
  let text = value.trim();
  if (!text) return undefined;
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(text);
  if (origin) text = text.slice(origin[0].length) || '/';
  else if (text.startsWith(PARAM)) {
    // `${API_BASE}/orders` -> `/orders`
    text = text.slice(PARAM.length);
    if (!text.startsWith('/')) return undefined;
  }
  if (!text.startsWith('/') || text.startsWith('//')) return undefined;
  text = text.split(/[?#]/)[0]!;
  if (/\s/.test(text)) return undefined;
  return joinRoute(text);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function dynamicSegmentCount(route: string): number {
  return route.split('/').filter(segment => /^(:|\[|\*)/.test(segment)).length;
}

/** Converts a route template (Express `:id`, Next `[id]`, catch-all `*`/`[...x]`) into a matcher. */
export function routeMatcher(route: string): RegExp {
  const parts = route.split('/').filter(Boolean).map(segment => {
    if (/^\[\[?\.\.\./.test(segment) || segment === '*' || segment === '**' || segment.endsWith('*')) return '(?:/.*)?';
    if (segment.startsWith(':') || /^\[.+\]$/.test(segment)) return '/[^/]+';
    return `/${escapeRegex(segment).replace(/:param/g, '[^/]+')}`;
  });
  return new RegExp(`^${parts.join('') || '/?'}/?$`, 'i');
}

/** Returns true when a concrete or partially-dynamic target path can reach the route template. */
export function routeMatches(route: string, target: string): boolean {
  // Placeholders in targets match any single segment; turn them into a concrete token.
  const concrete = target.replace(/:param/g, 'x0x').replace(/\/:[A-Za-z_]\w*/g, '/x0x');
  return routeMatcher(route).test(concrete);
}

export function clean(text: string, max = 120): string | undefined {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value || !/[A-Za-z]{2}/.test(value) || value.length > max) return undefined;
  return value;
}

export function isTestPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return /(^|\/)(test|tests|__tests__|e2e|cypress|playwright)\//i.test(normalized) ||
    /\.(test|spec|cy|e2e)\.[cm]?tsx?$/i.test(normalized) || /(^|\/)test\.[cm]?tsx?$/i.test(normalized);
}

export const GUARD_NAME = /(auth|guard|protect|private|permission|role|admin|login|signedin|loggedin|session|acl|policy)/i;
