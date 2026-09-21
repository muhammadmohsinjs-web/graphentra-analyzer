import { createHash } from 'node:crypto';
import { computeDeterministicEvidenceIdentity } from '@graphentra/analyzer';
import type { SubmissionPayload } from './contracts';

export function computeSubmissionIdempotencyKey(payload: SubmissionPayload): string {
  const evidenceIdentity = computeDeterministicEvidenceIdentity(payload.evidence);

  const canonicalFields = {
    repository: payload.repository.name,
    prNumber: payload.pullRequest?.number ?? null,
    target: payload.evidence.target.targetPath,
    comparisonPolicy: payload.comparisonPolicy,
    comparison: {
      mode: payload.evidence.comparison.mode,
      resolvedBaseSha: payload.evidence.comparison.resolvedBaseSha,
      resolvedHeadSha: payload.evidence.comparison.resolvedHeadSha,
    },
    analyzerVersion: payload.evidence.analyzerVersion,
    schemaVersion: payload.evidence.schemaVersion,
    evidenceIdentity,
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalFields))
    .digest('hex');
}
