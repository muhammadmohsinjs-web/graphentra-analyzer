import * as ts from 'typescript';
import { compareStrings } from './deterministic';
import type { ChangedEntity, ChangedFile, Entity, EntityImpact, ValueFlowTarget } from './contracts';
import type { ExtractedGraph } from './technical-graph';

// Finds the code that receives a changed value, which the walk toward callers never reaches.
// It follows values, not call edges: a forward walk over the same corpus added 73 or more entities per
// commit and found fewer of the real consumers, because most callees of a changed function get nothing new.
// Limits were chosen on the D-0 corpus. Going deeper added noise and found nothing more.
const MAX_RETURN_HOPS = 1;
const MAX_CALL_DEPTH = 1;
const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?)\/|\.(test|spec)\.[jt]sx?$/;
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

type FunctionNode = ts.FunctionLikeDeclaration;
type Seed = { entityId: string; channel: 'return' } | { entityId: string; channel: 'param'; index: number };

const isFunctionNode = (node: ts.Node): node is FunctionNode =>
  ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node);

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

class ProgramIndex {
  readonly callSites = new Map<string, ts.CallExpression[]>();
  readonly references = new Map<ts.Symbol, ts.Identifier[]>();
  readonly entitiesByFile = new Map<string, Entity[]>();
  readonly sourceFiles = new Map<string, ts.SourceFile>();

  constructor(readonly graph: ExtractedGraph, private readonly checker: ts.TypeChecker) {
    for (const entity of graph.entities) push(this.entitiesByFile, entity.file, entity);
    for (const sourceFile of graph.program!.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) continue;
      const file = graph.toProjectPath!(sourceFile.fileName);
      if (!this.entitiesByFile.has(file)) continue;
      this.sourceFiles.set(file, sourceFile);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = this.entityOf(this.calleeSymbol(node));
          if (callee) push(this.callSites, callee.id, node);
        } else if (ts.isIdentifier(node)) {
          const symbol = this.resolve(node);
          if (symbol) push(this.references, symbol, node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  resolve(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  calleeSymbol(call: ts.CallExpression | ts.NewExpression): ts.Symbol | undefined {
    const callee = call.expression;
    const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
    return name && this.resolve(name);
  }

  entityOf(symbol: ts.Symbol | undefined): Entity | undefined {
    return symbol && this.graph.symbolToEntity!.get(symbol);
  }

  /** The innermost entity holding a node. */
  enclosing(node: ts.Node): Entity | undefined {
    const sourceFile = node.getSourceFile();
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    let best: Entity | undefined;
    for (const entity of this.entitiesByFile.get(this.graph.toProjectPath!(sourceFile.fileName)) ?? []) {
      if (entity.startLine <= line && line <= entity.endLine && (!best || entity.endLine - entity.startLine < best.endLine - best.startLine)) best = entity;
    }
    return best;
  }

  functionOf(symbol: ts.Symbol | undefined): FunctionNode | undefined {
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return undefined;
    if (isFunctionNode(declaration)) return declaration;
    const initializer = ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)
      ? declaration.initializer : undefined;
    if (!initializer) return undefined;
    let value = unwrap(initializer);
    if (ts.isCallExpression(value) && value.arguments[0]) value = unwrap(value.arguments[0]); // throttle(fn)
    return isFunctionNode(value) ? value : undefined;
  }
}

const lineOf = (sourceFile: ts.SourceFile, position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;

function overlaps(sourceFile: ts.SourceFile, node: ts.Node, lines: Set<number>): boolean {
  const end = lineOf(sourceFile, node.end);
  for (let line = lineOf(sourceFile, node.getStart(sourceFile)); line <= end; line += 1) if (lines.has(line)) return true;
  return false;
}

// Characters a change stops passing on, and characters a receiver splits or searches on. When the two meet, the receiver
// likely relied on the old value (excalidraw-11: tabs became spaces before the spreadsheet parser split rows on tabs).
const WATCHED_CHARACTERS: Array<[string, string]> = [['\t', 'tab'], ['\n', 'newline'], ['\r', 'carriage return'], [',', 'comma'], [';', 'semicolon'], ['|', 'pipe']];
const SEARCHES = new Set(['split', 'includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith']);

function patternMatches(pattern: ts.Expression, character: string): boolean {
  if (ts.isStringLiteralLike(pattern)) return pattern.text.includes(character);
  if (!ts.isRegularExpressionLiteral(pattern)) return false;
  const source = pattern.text.slice(1, pattern.text.lastIndexOf('/'));
  try { return new RegExp(source).test(character); } catch { return false; }
}

/** Characters this `replace` call removes: matched by the pattern and absent from a literal replacement. */
function removedBy(call: ts.CallExpression): string[] {
  if (!ts.isPropertyAccessExpression(call.expression) || !['replace', 'replaceAll'].includes(call.expression.name.text)) return [];
  const [pattern, replacement] = call.arguments;
  if (!pattern || !replacement || !ts.isStringLiteralLike(replacement)) return [];
  return WATCHED_CHARACTERS.filter(([character]) => patternMatches(pattern, character) && !replacement.text.includes(character)).map(([, name]) => name);
}

/** Characters the changed lines newly remove, directly or in a function they newly call (one call down). */
function charactersRemovedByChange(index: ProgramIndex, changed: ChangedEntity): Set<string> {
  const { entity, change } = changed;
  const sourceFile = index.sourceFiles.get(entity.file);
  const removedNames = new Set<string>();
  if (!sourceFile) return removedNames;
  const lines = new Set(change.changedLines);
  const before = change.removedCode.join('\n');
  const scan = (root: ts.Node, onlyChanged: boolean): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (!onlyChanged || (overlaps(sourceFile, node, lines) && !before.includes(node.getText(sourceFile))))) {
        for (const name of removedBy(node)) removedNames.add(name);
        if (onlyChanged) {
          const symbol = index.calleeSymbol(node);
          const callee = index.functionOf(symbol);
          const calleeName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
          if (callee?.body && calleeName && !before.includes(`${calleeName}(`)) scan(callee.body, false);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  const statements = sourceFile.statements.filter(statement => lineOf(sourceFile, statement.end) >= entity.startLine && lineOf(sourceFile, statement.getStart(sourceFile)) <= entity.endLine);
  for (const statement of statements) scan(statement, true);
  return removedNames;
}

/** Characters a receiver splits or searches its input on. */
function charactersSearchedBy(index: ProgramIndex, entity: Entity): Set<string> {
  const names = new Set<string>();
  const sourceFile = index.sourceFiles.get(entity.file);
  if (!sourceFile) return names;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SEARCHES.has(node.expression.name.text) && node.arguments[0]) {
      const line = lineOf(sourceFile, node.getStart(sourceFile));
      if (line >= entity.startLine && line <= entity.endLine) {
        for (const [character, name] of WATCHED_CHARACTERS) if (patternMatches(node.arguments[0], character)) names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** Values a changed entity's own changed lines produce: call arguments, and its return value. */
function changedLineSeeds(index: ProgramIndex, changed: ChangedEntity): Seed[] {
  const { entity, change } = changed;
  const sourceFile = index.sourceFiles.get(entity.file);
  if (!sourceFile) return [];
  const lines = new Set(change.changedLines);
  const removed = change.removedCode.join('\n');
  // An expression on a changed line whose exact text existed before the change is not itself changed.
  const touched = (node: ts.Node): boolean => overlaps(sourceFile, node, lines) && !removed.includes(node.getText(sourceFile));
  const inEntity = (node: ts.Node): boolean => {
    const line = lineOf(sourceFile, node.getStart(sourceFile));
    return line >= entity.startLine && line <= entity.endLine && index.enclosing(node)?.id === entity.id;
  };

  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && inEntity(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const tainted = new Set<ts.Symbol>();
  const usesTainted = (expression: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node)) {
        const symbol = index.resolve(node);
        if (symbol && tainted.has(symbol)) found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };
  const carries = (expression: ts.Node): boolean => touched(expression) || usesTainted(expression);
  for (let grew = true; grew;) {
    grew = false;
    for (const declaration of declarations) {
      const symbol = index.resolve(declaration.name);
      if (symbol && !tainted.has(symbol) && carries(declaration.initializer!)) {
        tainted.add(symbol);
        grew = true;
      }
    }
  }

  const seeds: Seed[] = [];
  let returnSeeded = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && inEntity(node)) {
      const target = index.entityOf(index.calleeSymbol(node));
      if (target) node.arguments.forEach((argument, position) => {
        if (carries(argument)) seeds.push({ entityId: target.id, channel: 'param', index: position });
      });
    }
    const returned = ts.isReturnStatement(node) ? node.expression : ts.isArrowFunction(node) && !ts.isBlock(node.body) ? node.body : undefined;
    if (!returnSeeded && returned && inEntity(returned) && carries(returned)) {
      returnSeeded = true;
      seeds.push({ entityId: entity.id, channel: 'return' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return seeds;
}

/** Every function that reads a module-level constant declared on a changed line of this file. */
function changedConstantSeeds(index: ProgramIndex, changedFile: ChangedFile): Seed[] {
  const sourceFile = index.sourceFiles.get(changedFile.file);
  if (!sourceFile) return [];
  const lines = new Set(changedFile.changedLines);
  const seeds: Seed[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !overlaps(sourceFile, declaration, lines)) continue;
      const symbol = index.resolve(declaration.name);
      if (!symbol || index.entityOf(symbol)) continue; // A function is an entity, and its callers are already covered.
      for (const reference of index.references.get(symbol) ?? []) {
        if (reference === declaration.name) continue;
        const reader = index.enclosing(reference);
        if (reader && reader.kind !== 'module') seeds.push({ entityId: reader.id, channel: 'return' });
      }
    }
  }
  return seeds;
}

/** Follows seeds and returns each entity that receives the value, with the entity it arrived through. */
function follow(index: ProgramIndex, sourceId: string, seeds: Seed[]): Map<string, string> {
  const received = new Map<string, string>();
  const mark = (entity: Entity | undefined, through: string): void => {
    if (entity && !received.has(entity.id)) received.set(entity.id, through);
  };

  interface Scope { owner: string; fn?: FunctionNode; returned: boolean; seen: Set<ts.Node>; symbols: Set<ts.Symbol>; depth: number }
  const summaries = new Map<string, boolean>();

  /** Whether a function hands the parameter back to its caller, so only the call that passed the value keeps tracking it. */
  const followParameter = (callee: Entity, fn: FunctionNode | undefined, position: number, depth: number): boolean => {
    if (!fn || depth > MAX_CALL_DEPTH) return false;
    const key = `${callee.id}:${position}`;
    const known = summaries.get(key);
    if (known !== undefined) return known;
    summaries.set(key, false);
    const parameter = fn.parameters[position];
    if (!parameter) return false;
    const scope: Scope = { owner: callee.id, fn, returned: false, seen: new Set(), symbols: new Set(), depth };
    taint(parameter.name, scope);
    summaries.set(key, scope.returned);
    return scope.returned;
  };

  const taint = (name: ts.BindingName, scope: Scope): void => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) taint(element.name, scope);
      return;
    }
    const symbol = index.resolve(name);
    if (!symbol || scope.symbols.has(symbol)) return;
    scope.symbols.add(symbol);
    for (const reference of index.references.get(symbol) ?? []) carry(reference, scope);
  };

  /** `node` holds the value. Decide where it goes next. */
  function carry(node: ts.Node, scope: Scope): void {
    if (scope.seen.has(node)) return;
    scope.seen.add(node);
    const parent = node.parent;
    if (!parent) return;
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer === node) taint(parent.name, scope);
    } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const position = parent.arguments?.indexOf(node as ts.Expression) ?? -1;
      if (position < 0) return;
      const symbol = index.calleeSymbol(parent);
      const callee = index.entityOf(symbol);
      if (!callee) carry(parent, scope); // A library call: assume its result still carries the value.
      else {
        mark(callee, scope.owner);
        if (followParameter(callee, index.functionOf(symbol), position, scope.depth + 1)) carry(parent, scope);
      }
    } else if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      if (parent.expression !== node) return;
      const outer = parent.parent;
      if (ts.isCallExpression(outer) && outer.expression === parent) {
        mark(index.entityOf(index.calleeSymbol(outer)), scope.owner);
        carry(outer, scope);
      } else carry(parent, scope);
    } else if (ts.isConditionalExpression(parent)) {
      if (parent.condition !== node) carry(parent, scope);
    } else if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (parent.right === node) {
          if (ts.isIdentifier(parent.left)) taint(parent.left, scope);
          carry(parent, scope);
        }
      } else if (!COMPARISONS.has(parent.operatorToken.kind)) carry(parent, scope);
    } else if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
      let fn: ts.Node | undefined = parent;
      while (fn && !isFunctionNode(fn)) fn = fn.parent;
      if (scope.fn) scope.returned ||= fn === scope.fn;
      else if (fn) scope.returned ||= !(fn.parent && (ts.isCallExpression(fn.parent) || ts.isNewExpression(fn.parent))); // Not a callback.
    } else if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isAwaitExpression(parent) ||
      ts.isTypeAssertionExpression(parent) || ts.isSpreadElement(parent) || ts.isArrayLiteralExpression(parent) || ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) || (ts.isPrefixUnaryExpression(parent) && parent.operator !== ts.SyntaxKind.ExclamationToken)) {
      carry(parent, scope);
    }
  }

  const seenReturns = new Set<string>();
  const queue: Array<{ id: string; hops: number }> = [];
  const enqueue = (id: string, hops: number): void => {
    if (hops <= MAX_RETURN_HOPS && !seenReturns.has(id)) {
      seenReturns.add(id);
      queue.push({ id, hops });
    }
  };
  const ordered = [...seeds].sort((left, right) => compareStrings(left.entityId, right.entityId));
  for (const seed of ordered) {
    const entity = index.graph.entityById.get(seed.entityId);
    if (!entity) continue;
    mark(entity, sourceId);
    if (seed.channel === 'return') enqueue(entity.id, 0);
    else {
      const call = index.callSites.get(entity.id)?.[0]; // Any call site names the same declaration.
      followParameter(entity, call && index.functionOf(index.calleeSymbol(call)), seed.index, 0);
    }
  }
  while (queue.length > 0) {
    const { id, hops } = queue.shift()!;
    for (const call of index.callSites.get(id) ?? []) {
      const caller = index.enclosing(call);
      if (caller && caller.id !== id && !ts.isExpressionStatement(call.parent)) mark(caller, id);
      const scope: Scope = { owner: caller?.id ?? id, returned: false, seen: new Set(), symbols: new Set(), depth: 0 };
      carry(call, scope);
      if (scope.returned && caller) enqueue(caller.id, hops + 1);
    }
  }
  return received;
}

/** Adds `receivesChangedValue` to each impact: code that gets a changed value but is not otherwise flagged. */
export function withChangedValueTargets(options: {
  extracted: ExtractedGraph;
  changedEntities: ChangedEntity[];
  changedFiles: ChangedFile[];
  impacts: EntityImpact[];
}): EntityImpact[] {
  const { extracted, changedEntities, changedFiles, impacts } = options;
  if (!extracted.program || !extracted.checker || !extracted.symbolToEntity || !extracted.toProjectPath || impacts.length === 0) return impacts;

  const flagged = new Set(impacts.flatMap(impact => [impact.changedEntity.id, ...impact.blastRadius.entities.map(entity => entity.id)]));
  const changedById = new Map(changedEntities.map(changed => [changed.entity.id, changed]));
  const index = new ProgramIndex(extracted, extracted.checker);
  const constantSeeds = new Map(changedFiles.map(file => [file.file, changedConstantSeeds(index, file)]));

  return impacts.map(impact => {
    const changed = changedById.get(impact.changedEntity.id);
    const { id, kind, file } = impact.changedEntity;
    // A new function has no consumers that relied on it. Test-only and log-only edits change nothing downstream.
    const usable = changed && changed.changeKind !== 'added' && changed.changeKind !== 'deleted' &&
      !changed.changeClasses?.some(value => value === 'test_only' || value === 'log_only' || value === 'cosmetic');
    const seeds = [...(usable ? changedLineSeeds(index, changed) : []), ...(kind === 'module' ? constantSeeds.get(file) ?? [] : [])];
    if (seeds.length === 0) return impact;
    const removedCharacters = usable ? charactersRemovedByChange(index, changed) : new Set<string>();
    const targets: ValueFlowTarget[] = [...follow(index, id, seeds)]
      .filter(([target]) => !flagged.has(target) && !TEST_FILE.test(extracted.entityById.get(target)?.file ?? ''))
      .map(([target, through]) => {
        const entity = extracted.entityById.get(target)!;
        const relied = removedCharacters.size > 0 ? [...charactersSearchedBy(index, entity)].filter(name => removedCharacters.has(name)).sort(compareStrings) : [];
        return relied.length > 0 ? { entity, through, reliesOnRemovedCharacters: relied } : { entity, through };
      })
      .sort((left, right) => compareStrings(left.entity.id, right.entity.id));
    return targets.length > 0 ? { ...impact, receivesChangedValue: targets } : impact;
  });
}
