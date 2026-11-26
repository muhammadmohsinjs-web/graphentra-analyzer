import { buildGraphIndex, computeDeterministicEvidenceIdentity, readEvidence } from '@graphentra/analyzer';
import type {
  ApplicationMap,
  ChangedEntity,
  ChangedFile,
  Entity,
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
import { CLUSTER_THRESHOLD, DEFAULT_RELATED_BYTES, generateClusterReport, type ClusterOptions, type ClusterRunInfo } from './cluster-report';
import { buildSurfaceEvidence, formatSurfaceEvidence } from './surface-evidence';
import { createReportVerifier, type ReportVerification, type ReportVerifierOptions } from './verifier/verified-report';
import { budgetBytes, mentionedEntities, trimImpacts, type PayloadBudget } from './trim-payload';

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
  /** R-10: how the change was split and merged, only when the report was written in groups. */
  cluster?: ClusterRunInfo;
  /** R-3: present only when some evidence was cut to fit the model. */
  trim?: TrimInfo;
}

/** R-3: what was cut to fit the model, over every call of the run (the single call, or each group). */
export interface TrimInfo {
  /** Evidence byte budget for one call. */
  budgetBytes: number;
  /** Calls that needed trimming. */
  calls: number;
  /** Calls still over budget after every candidate was cut (sent anyway). */
  overBudget: number;
  /** (change, dependent) listings removed. */
  removed: number;
  /** Entities the model never saw; each is listed under "Not covered" with reason `trimmed`. */
  notSeen: number;
}

export interface GenerateReportExtras {
  /** Deterministic application map from the same analysis run; enables where/how-to-test guidance. */
  applicationMap?: ApplicationMap;
  /** Lets the report model read code at the analyzed revision before writing. */
  lookup?: { read: SourceReader; style?: 'optional' | 'always'; maxRounds?: number } & CodeLookupOptions;
  /** Phase V (ADR-0011): verify the finished report and list what it does not cover. No repair round (V-13). Off when absent. */
  verify?: ReportVerifierOptions;
  /**
   * R-10: when more than `threshold` (default 15) functions changed, review them in groups of related functions and merge
   * the group reports in code, instead of one call for everything. Smaller changes are unaffected. Takes precedence over
   * `lookup`, which it does not combine with (each group already carries the code a lookup would fetch).
   * On by default (R-8: on 29 large commits, 0 → 4 strict catches, 6 → 10 incl. borderline, no lost checks); pass `read`
   * so each group also carries its related code. `false` writes one report for everything (the eval baseline).
   * Trigger checks (`triggers`) stay opt-in until a held-out test.
   */
  cluster?: ClusterOptions | false;
  /**
   * R-3: the evidence budget for one call, as a share of the model's context window. The default fits the default model
   * (about 3.2 MB of compact evidence); pass `contextTokens` for a model with a smaller window (defaults in `trim-payload.ts`).
   * Over budget, the least useful indirect dependents are cut first and listed under "Not covered". Changed code,
   * diffs, totals and direct dependents are never cut. `false` turns trimming off.
   */
  budget?: PayloadBudget | false;
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
  const payloadOptions = {
    applicationMap, relations: evidence.technicalGraph.relations, graphIndex, contextWarnings: warnings,
    capabilities: evidence.technicalGraph.capabilities,
    surfaceEvidence,
  };
  // V-13e: the gaps are rewritten as plain QA checks by the writer's own model, unless the caller turned it off.
  const verifier = extras.verify
    ? createReportVerifier(evidence.impacts, { ...extras.verify, plainChecks: extras.verify.plainChecks ?? options ?? false })
    : undefined;
  // R-3: last-resort trimming. `fitted` returns the payload for the impacts as sent; the unchanged case builds it once.
  const maxBytes = extras.budget === false ? undefined : budgetBytes(extras.budget);
  const trim = { calls: 0, overBudget: 0, removed: 0 };
  const cutEntities = new Map<string, Entity>();
  const sentEntities = new Set<string>();
  const fitted = (subset: EntityImpact[], reserve = 0) => {
    const built = new Map<EntityImpact[], ReturnType<typeof buildLLMPayload>>();
    const size = (list: EntityImpact[]) => {
      const payload = buildLLMPayload(list, context, payloadOptions);
      built.set(list, payload);
      return Buffer.byteLength(JSON.stringify(compactLLMPayload(payload)));
    };
    const result = maxBytes === undefined
      ? { impacts: subset, cut: [] as Entity[], removed: 0, fits: true }
      : trimImpacts(subset, size, Math.max(1, maxBytes - reserve));
    if (result.removed > 0) {
      trim.calls += 1;
      trim.removed += result.removed;
      if (!result.fits) trim.overBudget += 1;
    }
    for (const entity of result.cut) cutEntities.set(entity.id, entity);
    for (const id of mentionedEntities(result.impacts)) sentEntities.add(id);
    return built.get(result.impacts) ?? buildLLMPayload(result.impacts, context, payloadOptions);
  };
  let writtenReport: ImpactReport;
  let tool: ReturnType<typeof createCodeLookup> | undefined;
  let cluster: ClusterRunInfo | undefined;
  const clusterOptions = extras.cluster === false ? undefined : extras.cluster ?? {};
  if (clusterOptions && evidence.impacts.length > (clusterOptions.threshold ?? CLUSTER_THRESHOLD)) {
    // R-10: one review per group of related changes; no full payload is built for the whole change.
    const clustered = await generateClusterReport({
      impacts: evidence.impacts, graphIndex, options, cluster: clusterOptions,
      // Each group also carries up to `maxRelatedBytes` of related code, so that much is kept free.
      buildPayload: subset => fitted(subset, clusterOptions.read ? clusterOptions.maxRelatedBytes ?? DEFAULT_RELATED_BYTES : 0),
    });
    writtenReport = clustered.report;
    cluster = clustered.info;
  } else {
    const payload = fitted(evidence.impacts);
    tool = extras.lookup ? createCodeLookup(evidence.technicalGraph, extras.lookup.read, { ...extras.lookup, graphIndex }) : undefined;
    writtenReport = await generateImpactReport({
      instruction: tool ? `${qaInstruction}\n\n${lookupInstruction(extras.lookup!.style)}` : qaInstruction,
      // R-2: the lossless compact form (one entity table, IDs elsewhere); about 3x smaller on large changes.
      evidence: compactLLMPayload(payload),
      options,
      allowedSurfaceIds: payload.applicationContext.allowedSurfaceIds,
      ...(tool ? { lookup: { tool, maxRounds: extras.lookup!.maxRounds, requireFirst: extras.lookup!.style === 'always' } } : {}),
    });
  }
  const verified = verifier ? await verifier.finish(writtenReport) : undefined;
  // A group whose review failed is listed by the cluster step; the verifier's own list replaces it, so keep both.
  const failedGroups = writtenReport.notCovered ?? [];
  const verifiedReport = verified?.report;
  const reported = verifiedReport && failedGroups.length
    ? { ...verifiedReport, notCovered: [...failedGroups, ...(verifiedReport.notCovered ?? []).filter(item => !failedGroups.some(failed => failed.entity === item.entity))] }
    : verifiedReport ?? writtenReport;
  // R-3: an entity cut from one group but sent in another was seen; only what no call carried is listed.
  const notSeen = [...cutEntities.values()].filter(entity => !sentEntities.has(entity.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listed = new Set((reported.notCovered ?? []).map(item => item.entity));
  const trimmedItems = notSeen.filter(entity => !listed.has(entity.id))
    .map(entity => ({ entity: entity.id, name: entity.name, file: entity.file, reason: 'trimmed' as const, score: null }));
  const qaReport = trimmedItems.length ? { ...reported, notCovered: [...(reported.notCovered ?? []), ...trimmedItems] } : reported;
  const trimInfo: TrimInfo | undefined = trim.calls > 0 && maxBytes !== undefined
    ? { budgetBytes: maxBytes, ...trim, notSeen: notSeen.length } : undefined;

  const markdownReport = `# Graphentra QA Impact Report\n\nEvidence Identity: ${evidenceIdentity}\n\n${formatImpactReport(qaReport)}${formatSurfaceEvidence(surfaceEvidence)}`;

  return {
    evidenceIdentity,
    qaReport,
    markdownReport,
    contextWarnings: warnings,
    ...(tool ? { lookups: tool.log } : {}),
    ...(verified ? { verification: verified.verification } : {}),
    ...(cluster ? { cluster } : {}),
    ...(trimInfo ? { trim: trimInfo } : {}),
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
