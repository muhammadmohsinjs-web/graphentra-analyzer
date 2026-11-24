import { buildGraphIndex, computeDeterministicEvidenceIdentity, readEvidence } from '@graphentra/analyzer';
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
import { compactLLMPayload } from './compact-payload';
import { createCodeLookup, lookupInstruction, type CodeLookupOptions, type LookupLogEntry, type SourceReader } from './code-lookup';
import { buildSurfaceEvidence, formatSurfaceEvidence } from './surface-evidence';
import { createReportVerifier, type ReportVerification, type ReportVerifierOptions } from './verifier/verified-report';

export interface GenerateReportResult {
  evidenceIdentity: string;
  qaReport: ImpactReport;
  markdownReport: string;
  /** Non-fatal notes about the application context (migration, stale entries). */
  contextWarnings: string[];
  /** What the model looked up, when lookup was enabled. */
  lookups?: LookupLogEntry[];
  /** Phase V verifier result and usage, only when `extras.verify` was given. */
  verification?: ReportVerification;
}

export interface GenerateReportExtras {
  /** Deterministic application map from the same analysis run; enables where/how-to-test guidance. */
  applicationMap?: ApplicationMap;
  /** Lets the report model read code at the analyzed revision before writing. */
  lookup?: { read: SourceReader; style?: 'optional' | 'always'; maxRounds?: number } & CodeLookupOptions;
  /** Phase V (ADR-0011): verify the finished report and list what it does not cover. No repair round (V-13). Off when absent. */
  verify?: ReportVerifierOptions;
}

export async function generateQAReport(
  rawEvidence: unknown,
  applicationContext: unknown,
  options?: LLMClientOptions,
  extras: GenerateReportExtras = {},
): Promise<GenerateReportResult> {
  const evidence = readEvidence(rawEvidence);
  const { context, warnings } = loadApplicationContext(applicationContext, evidence.technicalGraph);
  // Identity comes from the document as given: normalizing adds empty 3.0 collections that must not change a 2.x identity.
  const evidenceIdentity = computeDeterministicEvidenceIdentity(rawEvidence as typeof evidence);
  const applicationMap = extras.applicationMap && extras.applicationMap.schemaVersion === '1.0' ? extras.applicationMap : undefined;
  const surfaceEvidence = buildSurfaceEvidence(evidence);
  // R-1: one graph index per run, shared by the context pack's surface lookup and the code lookup tool.
  const graphIndex = buildGraphIndex({ entities: evidence.technicalGraph.entities, relations: evidence.technicalGraph.relations, applicationMap });
  const payload = buildLLMPayload(evidence.impacts, context, {
    applicationMap, relations: evidence.technicalGraph.relations, graphIndex, contextWarnings: warnings,
    capabilities: evidence.technicalGraph.capabilities,
    surfaceEvidence,
  });
  const tool = extras.lookup ? createCodeLookup(evidence.technicalGraph, extras.lookup.read, { ...extras.lookup, graphIndex }) : undefined;
  // V-13e: the gaps are rewritten as plain QA checks by the writer's own model, unless the caller turned it off.
  const verifier = extras.verify
    ? createReportVerifier(evidence.impacts, { ...extras.verify, plainChecks: extras.verify.plainChecks ?? options ?? false })
    : undefined;
  const writtenReport = await generateImpactReport({
    instruction: tool ? `${qaInstruction}\n\n${lookupInstruction(extras.lookup!.style)}` : qaInstruction,
    // R-2: the lossless compact form (one entity table, IDs elsewhere); about 3x smaller on large changes.
    evidence: compactLLMPayload(payload),
    options,
    allowedSurfaceIds: payload.applicationContext.allowedSurfaceIds,
    ...(tool ? { lookup: { tool, maxRounds: extras.lookup!.maxRounds, requireFirst: extras.lookup!.style === 'always' } } : {}),
  });
  const verified = verifier ? await verifier.finish(writtenReport) : undefined;
  const qaReport = verified?.report ?? writtenReport;

  const markdownReport = `# Graphentra QA Impact Report\n\nEvidence Identity: ${evidenceIdentity}\n\n${formatImpactReport(qaReport)}${formatSurfaceEvidence(surfaceEvidence)}`;

  return {
    evidenceIdentity,
    qaReport,
    markdownReport,
    contextWarnings: warnings,
    ...(tool ? { lookups: tool.log } : {}),
    ...(verified ? { verification: verified.verification } : {}),
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
