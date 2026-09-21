import { createHash } from 'node:crypto';
import type { DeterministicEvidence } from './contracts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
const ordered = <T>(items: T[]): T[] => [...items].sort((a, b) => {
  const left = JSON.stringify(canonical(a));
  const right = JSON.stringify(canonical(b));
  return left < right ? -1 : left > right ? 1 : 0;
});

/** Complete evidence identity; only graph.repository.generatedAt is volatile. */
export function computeDeterministicEvidenceIdentity(evidence: DeterministicEvidence): string {
  const { generatedAt: _timestamp, ...repository } = evidence.technicalGraph.repository;
  const payload = {
    ...evidence,
    options: { ...evidence.options, excludePaths: ordered(evidence.options.excludePaths) },
    technicalGraph: { ...evidence.technicalGraph, repository,
      analyzedFiles: ordered(evidence.technicalGraph.analyzedFiles),
      entities: ordered(evidence.technicalGraph.entities), relations: ordered(evidence.technicalGraph.relations) },
    changedFiles: ordered(evidence.changedFiles), changedEntities: ordered(evidence.changedEntities),
    impacts: ordered(evidence.impacts.map(impact => ({ ...impact,
      directDependents: ordered(impact.directDependents), terminalDependents: ordered(impact.terminalDependents),
      blastRadius: { ...impact.blastRadius, entities: ordered(impact.blastRadius.entities), paths: ordered(impact.blastRadius.paths) } }))),
    diagnostics: ordered(evidence.diagnostics), limitations: ordered(evidence.limitations),
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}
