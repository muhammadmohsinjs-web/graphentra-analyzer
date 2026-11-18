import { randomUUID } from 'crypto';
import type { EntityImpact } from '@graphentra/analyzer';
import { logLLMTrace, type ImpactReport, type NotCoveredItem } from '../llm-client';
import { addUsage, EMPTY_USAGE, type DecisionClient, type DecisionUsage } from './decision-client';
import type { BuildQuestionsOptions } from './questions';
import type { VerificationBlock, VerificationEntry } from './verdict';
import { verifyReport } from './verify-report';

// Phase V (ADR-0011), Chunk 3: wires the verifier into report generation.
// V-8 one targeted repair round, V-9 deterministic "Not covered" list, V-10 trace and usage.

export interface ReportVerifierOptions extends BuildQuestionsOptions {
  client: DecisionClient;
  /** Flag below this probability. Defaults to the V-3 threshold (0.7). */
  threshold?: number;
  concurrency?: number;
}

export interface ReportVerification {
  /** Verification of the final report (after the repair round, when one ran). */
  verification: VerificationBlock;
  /** Verifier tokens across every pass. The repair call itself is writer usage and is traced by the LLM client. */
  usage: DecisionUsage;
  /** Verifier passes run: 1, or 2 when a repair round produced a new report. */
  passes: number;
  /** A repair round was requested. */
  repairRequested: boolean;
  /** The repaired report was used (false when the repair answer was unusable and the first report was kept). */
  repairAccepted: boolean;
  durationMs: number;
}

const gaps = (block: VerificationBlock) => block.entries.filter(entry => entry.verdict === 'not_covered');

/** V-8: the message for the repair round, or undefined when nothing was flagged. Names the gaps; never asks to drop anything. */
export function buildRepairMessage(block: VerificationBlock, impacts: EntityImpact[]): string | undefined {
  const flagged = gaps(block);
  if (!flagged.length) return undefined;
  const byId = new Map(impacts.map(impact => [impact.changedEntity.id, impact]));
  const coverage = flagged.filter(entry => entry.kind === 'coverage' && entry.entity);
  const claims = flagged.filter(entry => entry.kind === 'faithfulness' && entry.claim);
  const lines = [
    'A coverage check of your report found the gaps below. Revise the complete report using only the same evidence above.',
    'Keep everything the report already covers; merge points if you need room, but do not drop any change or check.',
  ];
  if (coverage.length) {
    lines.push(
      '',
      'Changes in the evidence that no key change or QA check describes or tests. Add each one (a key change, a QA check, or both):',
      ...coverage.map(entry => `- ${entry.entity} (${byId.get(entry.entity!)?.change.file ?? 'unknown file'})`),
    );
  }
  if (claims.length) {
    lines.push(
      '',
      'Key changes that may not match the evidence. Re-check each against removedCode (BEFORE) and addedCode (AFTER) and correct it:',
      ...claims.map(entry => `- ${entry.claim}`),
    );
  }
  lines.push(
    '',
    'Return the complete JSON object matching the schema. Do not name source files, function names or entity IDs in the report text.',
  );
  return lines.join('\n');
}

/** V-9: coverage entries still flagged, as report items. Built by code from the verdicts, in evidence order. */
export function buildNotCovered(block: VerificationBlock, impacts: EntityImpact[]): NotCoveredItem[] {
  const flagged = new Map(
    gaps(block)
      .filter((entry): entry is VerificationEntry & { entity: string } => entry.kind === 'coverage' && Boolean(entry.entity))
      .map(entry => [entry.entity, entry]),
  );
  return impacts
    .filter(impact => flagged.has(impact.changedEntity.id))
    .map(impact => {
      const entry = flagged.get(impact.changedEntity.id)!;
      return {
        entity: impact.changedEntity.id,
        name: impact.changedEntity.name,
        file: impact.changedEntity.file,
        reason: entry.reason as NotCoveredItem['reason'],
        score: entry.score,
      };
    });
}

/** Adds the "Not covered" list. Purely additive: every field of the report is kept as it is. */
export function withNotCovered(report: ImpactReport, notCovered: NotCoveredItem[]): ImpactReport {
  return notCovered.length ? { ...report, notCovered } : report;
}

/**
 * One verifier per report. Pass `review` to `generateImpactReport`; call `finish` with the report it returns.
 * `finish` re-checks only when the final report is not the one already checked (the repaired one, or one that
 * came from a semantic retry and was never reviewed).
 */
export function createReportVerifier(impacts: EntityImpact[], options: ReportVerifierOptions) {
  const verifyId = randomUUID();
  const startedAt = Date.now();
  let usage = EMPTY_USAGE;
  let passes = 0;
  let repairRequested = false;
  let checked: { report: ImpactReport; block: VerificationBlock } | undefined;

  const check = async (report: ImpactReport) => {
    const passStartedAt = Date.now();
    passes += 1;
    const result = await verifyReport({
      client: options.client,
      impacts,
      report,
      threshold: options.threshold,
      concurrency: options.concurrency,
      priorState: options.priorState,
      cacheKey: verifyId,
    });
    usage = addUsage(usage, result.usage);
    const flagged = gaps(result.verification);
    logLLMTrace('verifier.completed', {
      verifyId,
      pass: passes,
      questions: result.verification.entries.length,
      threshold: result.verification.threshold,
      coverageGaps: flagged.filter(entry => entry.kind === 'coverage').length,
      faithfulnessFlags: flagged.filter(entry => entry.kind === 'faithfulness').length,
      durationMs: Date.now() - passStartedAt,
      usage: result.usage,
      scores: result.verification.entries.map(entry => ({ id: entry.id, score: entry.score, verdict: entry.verdict, reason: entry.reason })),
    });
    checked = { report, block: result.verification };
    return result.verification;
  };

  return {
    verifyId,
    /** V-8 hook for `generateImpactReport`: checks the report and returns a repair message when something is flagged. */
    async review(report: ImpactReport): Promise<string | undefined> {
      const message = buildRepairMessage(await check(report), impacts);
      if (message) repairRequested = true;
      return message;
    },
    /** Re-checks when needed and adds the deterministic "Not covered" list (V-9). */
    async finish(report: ImpactReport): Promise<{ report: ImpactReport; verification: ReportVerification }> {
      const reviewed = checked?.report;
      const block = checked && reviewed === report ? checked.block : await check(report);
      const notCovered = buildNotCovered(block, impacts);
      const repairAccepted = repairRequested && reviewed !== undefined && report !== reviewed;
      logLLMTrace('verifier.finished', {
        verifyId,
        passes,
        repairRequested,
        repairAccepted,
        notCovered: notCovered.length,
        durationMs: Date.now() - startedAt,
        usage,
      });
      return {
        report: withNotCovered(report, notCovered),
        verification: { verification: block, usage, passes, repairRequested, repairAccepted, durationMs: Date.now() - startedAt },
      };
    },
  };
}
