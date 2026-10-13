import * as ts from 'typescript';
import type { EntityCandidate } from './entity-collector';
import { DEFAULT_EXPORT_SEGMENT } from './entity-identity';

// Extended engine only. A candidate is a React component when it is a function in a .tsx/.jsx file,
// its last name segment is PascalCase (or it is the anonymous default export), and its declaration
// subtree contains any JSX. "Any JSX in body" deliberately accepts a component that returns null in
// one branch and JSX in another. Wrappers such as memo/forwardRef are already unwrapped by the
// collector, so a wrapped function is just a PascalCase variable-bound function here. Syntactic only.

const JSX_FILE = /\.(tsx|jsx)$/;

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return ts.forEachChild(node, child => (containsJsx(child) ? true : undefined)) === true;
}

export function isComponentCandidate(candidate: EntityCandidate, sourceFile: ts.SourceFile): boolean {
  const { entity } = candidate;
  if (entity.kind !== 'function') return false;
  if (!JSX_FILE.test(sourceFile.fileName) && !JSX_FILE.test(entity.file)) return false;
  const last = entity.name.slice(entity.name.lastIndexOf('>') + 1).replace(/~\d+$/, '');
  const pascal = /^[A-Z]/.test(last);
  const anonymousDefault = last === DEFAULT_EXPORT_SEGMENT && candidate.exportDefault === true && !entity.name.includes('>');
  if (!pascal && !anonymousDefault) return false;
  return containsJsx(candidate.declarationNode);
}
