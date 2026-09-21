import { assertValidEvidenceEnvelope, computeDeterministicEvidenceIdentity } from '@graphentra/analyzer';
import { assertApplicationContext } from './application-context';
import type {
  ChangedEntity,
  ChangedFile,
  EntityImpact,
} from '@graphentra/analyzer';
import type { ApplicationContext, LegacyAnalysisResult } from './contracts';
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
}

export async function generateQAReport(
  evidence: unknown,
  applicationContext: unknown,
  options?: LLMClientOptions,
): Promise<GenerateReportResult> {
  assertValidEvidenceEnvelope(evidence);
  const context = assertApplicationContext(applicationContext, evidence.technicalGraph);
  const evidenceIdentity = computeDeterministicEvidenceIdentity(evidence);
  const payload = buildLLMPayload(evidence.impacts, context);
  const qaReport = await generateImpactReport({
    instruction: qaInstruction,
    evidence: payload,
    options,
  });

  const markdownReport = `# Graphentra QA Impact Report\n\nEvidence Identity: ${evidenceIdentity}\n\n${formatImpactReport(qaReport)}`;

  return {
    evidenceIdentity,
    qaReport,
    markdownReport,
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
      'Application surfaces are not yet discovered.',
      'Blast radius is limited to depth 6.',
    ],
  };
}
