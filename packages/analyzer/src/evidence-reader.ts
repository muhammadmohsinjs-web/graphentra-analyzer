import type { DeterministicEvidence, SurfaceEdge, SurfaceNode, TestMapping, TestNode } from './contracts';
import { assertValidEvidenceEnvelope } from './validator';

/** A validated evidence document with the schema 3.0 collections always present (empty for 2.x). */
export type NormalizedEvidence = DeterministicEvidence & {
  surfaces: SurfaceNode[];
  surfaceEdges: SurfaceEdge[];
  tests: TestNode[];
  testMapping: TestMapping;
};

/**
 * The one way to read evidence of any schema version (2.0, 2.1, 3.0).
 * Throws EvidenceValidationError listing every problem when the document is invalid.
 * The input is not modified.
 */
export function readEvidence(doc: unknown): NormalizedEvidence {
  assertValidEvidenceEnvelope(doc);
  return {
    ...doc,
    surfaces: doc.surfaces ?? [],
    surfaceEdges: doc.surfaceEdges ?? [],
    tests: doc.tests ?? [],
    testMapping: doc.testMapping ?? { basis: 'static-reach', testsToRun: [], uncoveredSurfaces: [] },
  };
}
