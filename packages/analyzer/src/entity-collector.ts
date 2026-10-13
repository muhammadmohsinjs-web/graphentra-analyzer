import * as ts from 'typescript';
import { JAVASCRIPT_EXTENSIONS, type Entity, type EntityLanguage, type EngineProfile } from './contracts';
import { isComponentCandidate } from './component-heuristic';
import {
  DEFAULT_EXPORT_SEGMENT,
  MODULE_SEGMENT,
  buildEntityId,
  createIdAllocator,
  escapeSegment,
  nestedName,
} from './entity-identity';

export interface EntityCandidate {
  entity: Entity;
  /** The AST node that declares the entity (e.g. the FunctionDeclaration). */
  declarationNode: ts.Node;
  /** Nodes whose symbols should map to this entity (callers resolve them with the checker). */
  symbolNodes: ts.Node[];
  /** Enclosing entity candidate, when nested (unused by the legacy engine). */
  parent?: EntityCandidate;
  /** Extended only: the file's `default` export symbol also maps to this entity. */
  exportDefault?: boolean;
  /** Extended only: the base ID this candidate collided with before `~N` was appended. */
  disambiguatedFrom?: string;
}

export function languageForFile(file: string): EntityLanguage {
  const dot = file.lastIndexOf('.');
  return dot >= 0 && JAVASCRIPT_EXTENSIONS.has(file.slice(dot)) ? 'javascript' : 'typescript';
}

export interface CollectOptions {
  relativeFile: string;
  engine: EngineProfile;
}

export function collectEntities(sourceFile: ts.SourceFile, options: CollectOptions): EntityCandidate[] {
  if (options.engine === 'extended') return collectExtendedEntities(sourceFile, options.relativeFile);
  const { relativeFile } = options;
  const candidates: EntityCandidate[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const entity: Entity = {
        id: `${relativeFile}#${node.name.text}`,
        kind: 'function',
        name: node.name.text,
        file: relativeFile,
        startLine: start.line + 1,
        endLine: end.line + 1,
      };
      candidates.push({ entity, declarationNode: node, symbolNodes: [node.name] });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return candidates;
}

const WRAPPER_CALLEES = new Set(['useCallback', 'useMemo', 'memo', 'forwardRef']);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

const isFunctionLike = (node: ts.Expression): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node);

function isFunctionInitializer(initializer: ts.Expression | undefined): boolean {
  if (!initializer) return false;
  const value = unwrapExpression(initializer);
  if (isFunctionLike(value)) return true;
  if (!ts.isCallExpression(value)) return false;
  const callee = value.expression;
  const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  if (calleeName === undefined || !WRAPPER_CALLEES.has(calleeName)) return false;
  const first = value.arguments[0];
  return !!first && isFunctionLike(unwrapExpression(first));
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === kind);

/** `exports.name = <fn>` / `module.exports.name = <fn>` as a statement. */
function commonJsExportedFunction(statement: ts.ExpressionStatement): { name: ts.Identifier } | undefined {
  const expression = statement.expression;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const left = expression.left;
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) return undefined;
  if (!isFunctionLike(unwrapExpression(expression.right))) return undefined;
  const target = left.expression;
  const isExports = ts.isIdentifier(target) && target.text === 'exports';
  const isModuleExports = ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) &&
    target.expression.text === 'module' && target.name.text === 'exports';
  return isExports || isModuleExports ? { name: left.name } : undefined;
}

function collectExtendedEntities(sourceFile: ts.SourceFile, relativeFile: string): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];
  const allocator = createIdAllocator();

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  function add(
    rawName: string,
    parent: EntityCandidate | undefined,
    declarationNode: ts.Node,
    rangeStart: number,
    symbolNodes: ts.Node[],
    extra: { exported?: boolean; exportDefault?: boolean },
  ): EntityCandidate {
    const segment = escapeSegment(rawName);
    // Only a non-module parent contributes a qualified-name prefix.
    const moduleLevel = !parent || parent.entity.kind === 'module';
    const baseName = moduleLevel ? segment : nestedName(parent.entity.name, segment);
    const baseId = buildEntityId(relativeFile, baseName);
    const allocated = allocator.allocate(baseId);
    const entity: Entity = {
      id: allocated.id,
      kind: 'function',
      name: allocated.id.slice(relativeFile.length + 1),
      file: relativeFile,
      startLine: lineOf(rangeStart),
      endLine: lineOf(declarationNode.getEnd()),
      language: languageForFile(relativeFile),
    };
    if (moduleLevel && extra.exported !== undefined) entity.exported = extra.exported;
    if (moduleLevel && extra.exportDefault) entity.exportName = DEFAULT_EXPORT_SEGMENT;
    const candidate: EntityCandidate = { entity, declarationNode, symbolNodes };
    if (parent) candidate.parent = parent;
    if (extra.exportDefault) candidate.exportDefault = true;
    if (allocated.disambiguated) candidate.disambiguatedFrom = baseId;
    candidates.push(candidate);
    return candidate;
  }

  /** Index of the first same-named bodiless overload signature directly preceding `node`, if any. */
  function overloadStart(node: ts.FunctionDeclaration): number {
    const parent = node.parent;
    const statements = ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent)
      ? parent.statements
      : ts.isCaseOrDefaultClause(parent) ? parent.statements : undefined;
    let start = node.getStart(sourceFile);
    if (!statements || !node.name) return start;
    let index = statements.indexOf(node) - 1;
    while (index >= 0) {
      const previous = statements[index]!;
      if (!ts.isFunctionDeclaration(previous) || previous.body || previous.name?.text !== node.name.text) break;
      start = previous.getStart(sourceFile);
      index -= 1;
    }
    return start;
  }

  function visit(node: ts.Node, parent: EntityCandidate | undefined): void {
    let next = parent;

    if (ts.isFunctionDeclaration(node)) {
      // Bodiless declarations (overload signatures, `declare function`) never form entities.
      if (node.body) {
        const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
        const rawName = node.name?.text ?? (isDefault ? DEFAULT_EXPORT_SEGMENT : undefined);
        if (rawName !== undefined) {
          next = add(rawName, parent, node, overloadStart(node), node.name ? [node.name] : [], {
            exported: isDefault || hasModifier(node, ts.SyntaxKind.ExportKeyword),
            exportDefault: isDefault,
          });
        }
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionInitializer(node.initializer)) {
      const list = node.parent;
      const statement = ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) ? list.parent : undefined;
      const wholeStatement = !!statement && ts.isVariableDeclarationList(list) && list.declarations.length === 1;
      const rangeNode: ts.Node = wholeStatement ? statement : node;
      next = add(node.name.text, parent, rangeNode, rangeNode.getStart(sourceFile), [node.name], {
        exported: !!statement && hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
    } else if (ts.isExportAssignment(node) && !node.isExportEquals && isFunctionLike(unwrapExpression(node.expression))) {
      next = add(DEFAULT_EXPORT_SEGMENT, parent, node, node.getStart(sourceFile), [], { exported: true, exportDefault: true });
    } else if (ts.isExpressionStatement(node) && parent?.entity.kind === 'module') {
      const cjs = commonJsExportedFunction(node);
      if (cjs) next = add(cjs.name.text, parent, node, node.getStart(sourceFile), [cjs.name], { exported: true });
    }

    ts.forEachChild(node, child => visit(child, next));
  }

  const moduleEntity: Entity = {
    id: allocator.allocate(buildEntityId(relativeFile, MODULE_SEGMENT)).id,
    kind: 'module',
    name: MODULE_SEGMENT,
    file: relativeFile,
    startLine: 1,
    endLine: Math.max(1, lineOf(sourceFile.getEnd())),
    language: languageForFile(relativeFile),
  };
  const moduleCandidate: EntityCandidate = { entity: moduleEntity, declarationNode: sourceFile, symbolNodes: [] };
  candidates.push(moduleCandidate);

  visit(sourceFile, moduleCandidate);
  for (const candidate of candidates) if (isComponentCandidate(candidate, sourceFile)) candidate.entity.kind = 'component';
  return candidates;
}
