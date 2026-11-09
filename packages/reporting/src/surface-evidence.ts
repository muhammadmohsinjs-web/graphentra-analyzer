import type { EntityImpact, SurfaceNode, TestMapping } from '@graphentra/analyzer';

/** Schema 3.0 surface data for reports. Absent for 2.x evidence, so 2.x output is unchanged. */
export interface SurfaceEvidence {
  affectedSurfaces: Array<{ changedEntityId: string; surfaceId: string; depth: number; confidence: string }>;
  testsToRun: Array<{ testId: string; reaches: string[] }>;
  uncoveredSurfaces: string[];
}

export interface SurfaceEvidenceInput {
  impacts: EntityImpact[];
  surfaces: SurfaceNode[];
  testMapping: TestMapping;
}

export function buildSurfaceEvidence(input: SurfaceEvidenceInput): SurfaceEvidence | undefined {
  if (input.surfaces.length === 0) return undefined;
  const affectedSurfaces = input.impacts.flatMap(impact => (impact.affectedSurfaces ?? []).map(surface => ({
    changedEntityId: impact.changedEntity.id, surfaceId: surface.surfaceId, depth: surface.depth, confidence: surface.confidence,
  })));
  return {
    affectedSurfaces,
    testsToRun: input.testMapping.testsToRun.map(({ testId, reaches }) => ({ testId, reaches: [...reaches] })),
    uncoveredSurfaces: [...input.testMapping.uncoveredSurfaces],
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
