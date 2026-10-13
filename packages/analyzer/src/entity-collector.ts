import * as ts from 'typescript';
import type { Entity, EngineProfile } from './contracts';

export interface EntityCandidate {
  entity: Entity;
  /** The AST node that declares the entity (e.g. the FunctionDeclaration). */
  declarationNode: ts.Node;
  /** Nodes whose symbols should map to this entity (callers resolve them with the checker). */
  symbolNodes: ts.Node[];
  /** Enclosing entity candidate, when nested (unused by the legacy engine). */
  parent?: EntityCandidate;
}

export interface CollectOptions {
  relativeFile: string;
  engine: EngineProfile;
}

export function collectEntities(sourceFile: ts.SourceFile, options: CollectOptions): EntityCandidate[] {
  const { relativeFile } = options;
  const candidates: EntityCandidate[] = [];

  // The 'extended' engine currently matches legacy; its branches come in later tasks.
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
