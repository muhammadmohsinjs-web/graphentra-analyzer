import { assertValidEvidenceEnvelope, computeDeterministicEvidenceIdentity } from '@graphentra/analyzer';
import type {
  ApplicationMap,
  ChangedEntity,
  ChangedFile,
  EntityImpact,
} from '@graphentra/analyzer';
import { loadApplicationContext } from './context-contract';
import type { LegacyAnalysisResult } from './contracts';
import {
  formatImpactReport,
  generateImpactReport,
  type ImpactReport,
  type LLMClientOptions,
} from './llm-client';
import { buildLLMPayload, qaInstruction } from './qa-evidence';

export interface GenerateReportResult {
  evidenceIdentity: string;
  qaReport: ImpactReport;
  markdownReport: string;
  /** Non-fatal notes about the application context (migration, stale entries). */
  contextWarnings: string[];
}

export interface GenerateReportExtras {
  /** Deterministic application map from the same analysis run; enables where/how-to-test guidance. */
  applicationMap?: ApplicationMap;
}

export async function generateQAReport(
  evidence: unknown,
  applicationContext: unknown,
  options?: LLMClientOptions,
  extras: GenerateReportExtras = {},
): Promise<GenerateReportResult> {
  assertValidEvidenceEnvelope(evidence);
  const { context, warnings } = loadApplicationContext(applicationContext, evidence.technicalGraph);
  const evidenceIdentity = computeDeterministicEvidenceIdentity(evidence);
  const applicationMap = extras.applicationMap && extras.applicationMap.schemaVersion === '1.0' ? extras.applicationMap : undefined;
  const payload = buildLLMPayload(evidence.impacts, context, {
    applicationMap, relations: evidence.technicalGraph.relations, contextWarnings: warnings,
  });
  const qaReport = await generateImpactReport({
    instruction: qaInstruction,
    evidence: payload,
    options,
    allowedSurfaceIds: payload.applicationContext.allowedSurfaceIds,
  });

  const markdownReport = `# Graphentra QA Impact Report\n\nEvidence Identity: ${evidenceIdentity}\n\n${formatImpactReport(qaReport)}`;

  return {
    evidenceIdentity,
    qaReport,
    markdownReport,
    contextWarnings: warnings,
  };
}

export function buildLegacyAnalysisResult(options: {
  headSha: string;
  evidenceIdentity: string;
  changedFiles: ChangedFile[];
  changedEntities: ChangedEntity[];
  impacts: EntityImpact[];
  qaReport: ImpactReport;
  limitations?: string[];
}): LegacyAnalysisResult {
  return {
    schemaVersion: '1.1',
    repository: {
      headSha: options.headSha,
    },
    evidenceIdentity: options.evidenceIdentity,
    changedFiles: options.changedFiles,
    changedEntities: options.changedEntities,
    impacts: options.impacts,
    qaReport: options.qaReport,
    limitations: options.limitations ?? [
      'Only TypeScript is analyzed.',
      'Only named standalone function declarations are supported.',
      'Only CALLS relationships are currently supported.',
      'Class methods are not analyzed.',
      'Arrow functions are not analyzed.',
      'Dynamic calls are not analyzed.',
      'Deleted functions have no current graph entity; renamed or ambiguous functions may lack removed-code evidence.',
      'Overlapping function line ranges are skipped rather than sharing ambiguous evidence.',
      'Application surfaces come from static routing patterns; see application-map.json.',
      'Blast radius is limited to depth 6.',
    ],
  };
}
