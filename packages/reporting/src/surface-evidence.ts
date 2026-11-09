import type { EntityImpact, SurfaceNode, TestMapping } from '@graphentra/analyzer';

/** Schema 3.0 surface data for reports. Absent for 2.x evidence, so 2.x output is unchanged. */
export interface SurfaceEvidence {
  affectedSurfaces: Array<{ changedEntityId: string; surfaceId: string; depth: number; confidence: string }>;
  /** False when the 3.0 document has no testMapping (surface or test extraction failed); the lists below are then empty. */
  testMappingAvailable: boolean;
  testsToRun: Array<{ testId: string; reaches: string[] }>;
  uncoveredSurfaces: string[];
}

export interface SurfaceEvidenceInput {
  schemaVersion: string;
  impacts: EntityImpact[];
  surfaces: SurfaceNode[];
  testMapping?: TestMapping;
}

export function buildSurfaceEvidence(input: SurfaceEvidenceInput): SurfaceEvidence | undefined {
  // 2.x has no surfaces and no test mapping: nothing new is said. A 3.0 document without a testMapping is reported
  // as "unavailable" rather than read as "every surface covered".
  if (input.schemaVersion !== '3.0') return undefined;
  if (input.surfaces.length === 0 && input.testMapping) return undefined;
  const affectedSurfaces = input.impacts.flatMap(impact => (impact.affectedSurfaces ?? []).map(surface => ({
    changedEntityId: impact.changedEntity.id, surfaceId: surface.surfaceId, depth: surface.depth, confidence: surface.confidence,
  })));
  return {
    affectedSurfaces,
    testMappingAvailable: input.testMapping !== undefined,
    testsToRun: (input.testMapping?.testsToRun ?? []).map(({ testId, reaches }) => ({ testId, reaches: [...reaches] })),
    uncoveredSurfaces: [...(input.testMapping?.uncoveredSurfaces ?? [])],
  };
}

/** Markdown for the deterministic surface sections; empty string when there is nothing to show. */
export function formatSurfaceEvidence(evidence: SurfaceEvidence | undefined): string {
  if (!evidence) return '';
  const lines: string[] = [];
  if (evidence.affectedSurfaces.length) {
    lines.push('## Affected surfaces', '');
    for (const item of evidence.affectedSurfaces) lines.push(`- \`${item.surfaceId}\` (depth ${item.depth}, ${item.confidence}) from \`${item.changedEntityId}\``);
    lines.push('');
  }
  if (!evidence.testMappingAvailable) {
    lines.push('## Tests to run', '', '- Test mapping unavailable: surface or test extraction failed, so tests to run and uncovered surfaces are unknown.', '');
  }
  if (evidence.testsToRun.length) {
    lines.push('## Tests to run', '');
    for (const test of evidence.testsToRun) lines.push(`- \`${test.testId}\` reaches ${test.reaches.map(id => `\`${id}\``).join(', ') || 'no surface'}`);
    lines.push('');
  }
  if (evidence.uncoveredSurfaces.length) {
    lines.push('## Uncovered surfaces', '');
    for (const id of evidence.uncoveredSurfaces) lines.push(`- \`${id}\``);
    lines.push('');
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
}
