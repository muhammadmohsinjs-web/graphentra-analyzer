import { createHash } from 'node:crypto';
import * as ts from 'typescript';

export interface NormalizeOptions {
  renameParams?: boolean;
  dropLogCalls?: boolean;
}

interface Ctx {
  dropLogCalls: boolean;
  omit: Set<ts.Node>;
  root?: ts.Node;
}

type Rename = ReadonlyMap<string, string>;

const NO_RENAME: Rename = new Map();
const LOG_NAMES = new Set(['log', 'logger']);
const STATEMENT_LIST_PARENTS = new Set([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.SourceFile,
  ts.SyntaxKind.ModuleBlock,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
]);

const kindName = (node: ts.Node): string => ts.SyntaxKind[node.kind];

export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// A node that stands for an entity: itself when function-like, or the function initializer it wraps.
interface Resolved {
  fn: ts.Node;
  declaration?: ts.VariableDeclaration | ts.PropertyAssignment;
  holder?: ts.Node;
}

function resolve(node: ts.Node): Resolved {
  let declaration: ts.VariableDeclaration | ts.PropertyAssignment | undefined;
  if (ts.isVariableStatement(node)) {
    if (node.declarationList.declarations.length === 1) declaration = node.declarationList.declarations[0];
  } else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) declaration = node;
  if (declaration?.initializer) {
    const init = unwrapParens(declaration.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return { fn: init, declaration, holder: ts.isVariableStatement(node) ? node : variableStatementOf(declaration) };
    }
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    let parent: ts.Node | undefined = node.parent;
    while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent))) {
      return { fn: node, declaration: parent, holder: variableStatementOf(parent) };
    }
    if (parent && ts.isExportAssignment(parent)) return { fn: node, holder: parent };
  }
  return { fn: node, holder: node };
}

function variableStatementOf(node: ts.Node): ts.Node | undefined {
  const list = node.parent;
  const statement = list?.parent;
  return list && ts.isVariableDeclarationList(list) && statement && ts.isVariableStatement(statement)
    ? statement
    : undefined;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isLogName(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'console' || LOG_NAMES.has(node.text);
  return ts.isPropertyAccessExpression(node) && LOG_NAMES.has(node.name.text);
}

function isLogStatement(node: ts.Node): boolean {
  if (!ts.isExpressionStatement(node)) return false;
  const expression = unwrapParens(node.expression);
  if (!ts.isCallExpression(expression)) return false;
  const callee = unwrapParens(expression.expression);
  if (ts.isIdentifier(callee)) return LOG_NAMES.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    return isLogName(unwrapParens(callee.expression)) || LOG_NAMES.has(callee.name.text);
  }
  return false;
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, out);
}

function declaredInStatements(statements: readonly ts.Statement[], out: Set<string>): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, out);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      out.add(statement.name.text);
    }
  }
}

function hoistedVars(node: ts.Node, out: Set<string>): void {
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
    if (ts.isVariableDeclarationList(child) && !(child.flags & ts.NodeFlags.BlockScoped)) {
      for (const declaration of child.declarations) bindingNames(declaration.name, out);
    }
    hoistedVars(child, out);
  });
}

// Names a nested scope introduces, which shadow renamed parameters inside it.
function shadowedBy(node: ts.Node): Set<string> {
  const out = new Set<string>();
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) bindingNames(parameter.name, out);
    if ('body' in node && node.body) hoistedVars(node.body, out);
  } else if (ts.isBlock(node) || ts.isModuleBlock(node)) declaredInStatements(node.statements, out);
  else if (ts.isCatchClause(node) && node.variableDeclaration) bindingNames(node.variableDeclaration.name, out);
  else if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer) {
    if (ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) bindingNames(declaration.name, out);
    }
  }
  return out;
}

function isReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return true;
  if (ts.isTypeNode(parent) || ts.isTypeParameterDeclaration(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) {
    return ('expression' in parent ? parent.expression : parent.left) === identifier;
  }
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isEnumMember(parent) ||
    ts.isJsxAttribute(parent)
  ) {
    return parent.name !== identifier;
  }
  if (ts.isBindingElement(parent)) return parent.propertyName !== identifier;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

function operatorExtras(node: ts.Node): string {
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return `op=${ts.SyntaxKind[node.operator]};`;
  if (ts.isTypeOperatorNode(node)) return `op=${ts.SyntaxKind[node.operator]};`;
  if (ts.isMetaProperty(node)) return `kw=${ts.SyntaxKind[node.keywordToken]};`;
  if (ts.isVariableDeclarationList(node)) {
    return `decl=${node.flags & ts.NodeFlags.Const ? 'const' : node.flags & ts.NodeFlags.Let ? 'let' : 'var'};`;
  }
  if (ts.isImportClause(node) || ts.isExportDeclaration(node) || ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    return node.isTypeOnly ? 'typeOnly;' : '';
  }
  return '';
}

function leafText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return ts.isRegularExpressionLiteral(node) ? node.text : node.text;
  }
  if (ts.isJsxText(node)) return node.text.replace(/\s+/g, ' ').trim();
  return undefined;
}

function serialize(node: ts.Node, ctx: Ctx, rename: Rename): string {
  if (ts.isParenthesizedExpression(node) || ts.isParenthesizedTypeNode(node)) {
    return serialize(ts.isParenthesizedExpression(node) ? node.expression : node.type, ctx, rename);
  }
  if (ts.isIdentifier(node)) {
    const placeholder = rename.get(node.text);
    return placeholder !== undefined && isReference(node) ? `Identifier:${JSON.stringify(placeholder)}` : `Identifier:${JSON.stringify(node.text)}`;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    // `{ a }` keeps its key even when `a` is renamed.
    const value = serialize(node.name, ctx, rename);
    const init = node.objectAssignmentInitializer ? `,${serialize(node.objectAssignmentInitializer, ctx, rename)}` : '';
    return `ShorthandPropertyAssignment(key:${JSON.stringify(node.name.text)},${value}${init})`;
  }
  const leaf = leafText(node);
  if (leaf !== undefined) return `${kindName(node)}:${JSON.stringify(leaf)}`;

  let scope = rename;
  if (rename.size > 0 && node !== ctx.root) {
    const shadow = shadowedBy(node);
    if (shadow.size > 0) {
      scope = new Map([...rename].filter(([name]) => !shadow.has(name)));
    }
  }
  const dropHere = ctx.dropLogCalls && STATEMENT_LIST_PARENTS.has(node.kind);
  const parts: string[] = [];
  ts.forEachChild(node, (child) => {
    if (ctx.omit.has(child)) return;
    if (dropHere && isLogStatement(child)) return;
    if (ts.isJsxText(child) && !leafText(child)) return;
    parts.push(serialize(child, ctx, scope));
  });
  return `${kindName(node)}(${operatorExtras(node)}${parts.join(',')})`;
}

export function normalizeNode(node: ts.Node, options: NormalizeOptions = {}): string {
  const ctx: Ctx = { dropLogCalls: options.dropLogCalls === true, omit: new Set() };
  let rename: Rename = NO_RENAME;
  if (options.renameParams) {
    const { fn, declaration } = resolve(node);
    if (ts.isFunctionLike(fn)) {
      const names = new Map<string, string>();
      fn.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name)) names.set(parameter.name.text, `$p${index}`);
      });
      rename = names;
      ctx.root = fn;
      const own = (fn as ts.FunctionLikeDeclaration).name;
      if (own) ctx.omit.add(own);
      if (declaration) ctx.omit.add(declaration.name);
    }
  }
  return serialize(node, ctx, rename);
}

function modifierNames(node: ts.Node | undefined): string[] {
  if (!node || !ts.canHaveModifiers(node)) return [];
  return (ts.getModifiers(node) ?? []).map((modifier) => ts.SyntaxKind[modifier.kind].replace(/Keyword$/, '').toLowerCase());
}

const PLAIN: Ctx = { dropLogCalls: false, omit: new Set() };
const norm = (node: ts.Node | undefined): string => (node ? serialize(node, PLAIN, NO_RENAME) : 'none');

export function signatureOf(node: ts.Node): string {
  const { fn, declaration, holder } = resolve(node);
  const modifiers = [...new Set([...modifierNames(fn), ...modifierNames(holder), ...(holder && ts.isExportAssignment(holder) ? ['export', 'default'] : [])])].sort();
  const parts = [`mods=[${modifiers.join(',')}]`];
  if (ts.isFunctionLike(fn)) {
    const generator = (fn as ts.FunctionLikeDeclaration).asteriskToken ? '*' : '';
    parts.push(
      `gen=${generator}`,
      `tp=[${(fn.typeParameters ?? []).map(norm).join(',')}]`,
      `params=[${fn.parameters.map(norm).join(',')}]`,
      `ret=${norm(fn.type)}`,
    );
  } else if (ts.isClassLike(fn)) {
    parts.push(
      `tp=[${(fn.typeParameters ?? []).map(norm).join(',')}]`,
      `heritage=[${(fn.heritageClauses ?? []).map(norm).join(',')}]`,
    );
  }
  if (declaration && ts.isVariableDeclaration(declaration)) parts.push(`type=${norm(declaration.type)}`);
  return `sig(${parts.join(';')})`;
}

export function exportSurfaceOf(node: ts.Node): string {
  const { fn, declaration, holder } = resolve(node);
  const mods = new Set([...modifierNames(fn), ...modifierNames(holder)]);
  if (holder && ts.isExportAssignment(holder)) return 'default';
  const name = declaration
    ? ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
    : (fn as ts.NamedDeclaration).name && ts.isIdentifier((fn as ts.NamedDeclaration).name!)
      ? ((fn as ts.NamedDeclaration).name as ts.Identifier).text
      : undefined;
  if (mods.has('export')) return mods.has('default') ? 'default' : `named:${name ?? ''}`;
  // Top-level `export { a as b }` / `export default a` elsewhere in the file.
  const top = holder ?? fn;
  const file = top.parent && ts.isSourceFile(top.parent) ? top.parent : undefined;
  if (file && name) {
    for (const statement of file.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression) && statement.expression.text === name) {
        return 'default';
      }
      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          if ((specifier.propertyName ?? specifier.name).text === name) {
            return specifier.name.text === 'default' ? 'default' : `named:${specifier.name.text}`;
          }
        }
      }
    }
  }
  return 'none';
}
