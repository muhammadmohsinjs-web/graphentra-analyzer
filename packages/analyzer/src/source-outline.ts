import * as ts from 'typescript';

/** Default size cap for one file's outline, in characters. */
export const DEFAULT_OUTLINE_CHARS = 6_000;

const MAX_LINE = 200;
const MAX_CHECKS = 25;
const MAX_TEXTS = 30;
const comparison = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

const squash = (text: string, max = MAX_LINE) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Text a user could read on screen: JSX text, or a sentence-like string literal. */
const looksVisible = (text: string) => /[A-Za-z]{2,}/.test(text) && text.length <= 120
  && (/^[A-Z][a-z]/.test(text) || /[a-z] [a-z]/i.test(text)) && !/^[a-z0-9-]+( [a-z0-9-]+)*$/.test(text) && !text.includes('/');

const isNumeric = (node: ts.Node) => ts.isNumericLiteral(node)
  || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));

/**
 * A compact, deterministic outline of a TypeScript file for business summaries: imports, declarations and their
 * signatures with the first line of their doc comment, literal constants, comparisons against numbers (the
 * thresholds behind business rules), and user-visible text. Function bodies are left out.
 */
export function outlineSource(file: string, content: string, maxChars = DEFAULT_OUTLINE_CHARS): string {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
  const imports: string[] = [];
  const declarations: string[] = [];
  const checks = new Set<string>();
  const texts = new Set<string>();

  const doc = (node: ts.Node) => {
    const ranges = ts.getLeadingCommentRanges(content, node.getFullStart()) ?? [];
    const last = ranges[ranges.length - 1];
    if (!last) return '';
    const first = content.slice(last.pos, last.end).replace(/^\/\*+|\*+\/$|^\/\//g, '').split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').trim()).find(Boolean);
    return first ? `  // ${squash(first, 140)}` : '';
  };
  /** Declaration text up to its body, e.g. `export function charge(amount: number): boolean`. */
  const head = (node: ts.Node, body: ts.Node | undefined) =>
    squash(content.slice(node.getStart(source), body ? body.getStart(source) : node.getEnd()).replace(/[{=>\s]+$/, ''));

  const declare = (node: ts.Node, indent: string) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      declarations.push(`${indent}${head(node, node.body)}${doc(node)}`);
    } else if (ts.isClassDeclaration(node)) {
      declarations.push(`${indent}${head(node, node.members[0] ?? undefined).replace(/\{$/, '')}${doc(node)}`);
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
          declarations.push(`${indent}  ${head(member, member.initializer.body)}`);
        } else declare(member, `${indent}  `);
      }
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      declarations.push(`${indent}${squash(node.getText(source), MAX_LINE)}`);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const init = declaration.initializer;
        const exported = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? 'export ' : '';
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          declarations.push(`${indent}${exported}const ${head(declaration, init.body)}${doc(node)}`);
        } else if (init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || isNumeric(init)
          || init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)) {
          declarations.push(`${indent}${exported}const ${squash(declaration.getText(source))}`);
        } else if (init && ts.isCallExpression(init) && init.arguments.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
          // Wrapped components and hooks, e.g. `const Toolbar = memo((props) => …)`.
          declarations.push(`${indent}${exported}const ${declaration.name.getText(source)} = ${squash(init.expression.getText(source), 60)}(…)${doc(node)}`);
        } else if (exported && init && ts.isCallExpression(init)) {
          declarations.push(`${indent}export const ${declaration.name.getText(source)} = ${squash(init.expression.getText(source), 60)}(…)`);
        } else if (exported) {
          declarations.push(`${indent}export const ${declaration.name.getText(source)}`);
        }
      }
    }
  };

  const collect = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && comparison.has(node.operatorToken.kind) && (isNumeric(node.left) || isNumeric(node.right))
      && checks.size < MAX_CHECKS) {
      checks.add(squash(node.getText(source), 100));
    } else if (ts.isJsxText(node)) {
      const text = squash(node.getText(source), 120);
      if (text.length > 1 && /[A-Za-z]/.test(text) && texts.size < MAX_TEXTS) texts.add(text);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !ts.isImportDeclaration(node.parent)
      && !ts.isExportDeclaration(node.parent) && texts.size < MAX_TEXTS) {
      // Translation keys stand in for UI text, e.g. t("labels.delete").
      const translated = ts.isCallExpression(node.parent) && node.parent.arguments[0] === node
        && /^(t|i18n|translate|formatMessage)$/.test(node.parent.expression.getText(source).split('.').pop() ?? '');
      if (translated) texts.add(`t:${squash(node.text, 80)}`);
      else if (looksVisible(node.text)) texts.add(squash(node.text, 120));
    }
    ts.forEachChild(node, collect);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
    else if (ts.isExportDeclaration(statement)) declarations.push(squash(statement.getText(source)));
    else declare(statement, '');
  }
  collect(source);

  const lines = [
    `// ${content.split('\n').length} lines`,
    ...(imports.length ? [`imports: ${[...new Set(imports)].join(', ')}`] : []),
    ...declarations,
    ...(checks.size ? [`checks: ${[...checks].join(' | ')}`] : []),
    ...(texts.size ? [`text: ${[...texts].map(text => JSON.stringify(text)).join(', ')}`] : []),
  ];
  let outline = lines.join('\n');
  const truncated = '\n// … outline truncated';
  if (outline.length > maxChars) outline = `${outline.slice(0, maxChars - truncated.length)}${truncated}`;
  return outline;
}
