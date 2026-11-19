import { randomUUID } from 'crypto';
import type { EntityImpact } from '@graphentra/analyzer';
import { logLLMTrace, type ImpactReport, type NotCoveredItem } from '../llm-client';
import type { DecisionClient, DecisionUsage } from './decision-client';
import type { BuildQuestionsOptions } from './questions';
import type { VerificationBlock, VerificationEntry } from './verdict';
import { verifyReport } from './verify-report';

// Phase V (ADR-0011): wires the verifier into report generation.
// V-9 deterministic "Not covered" list, V-10 trace and usage. The V-8 repair round was removed at V-13 (2026-11-19):
// on corpus-32 it did not raise catch, cost +82 % writer prompt tokens and made some reports vaguer.

export interface ReportVerifierOptions extends BuildQuestionsOptions {
  client: DecisionClient;
  /** Flag below this probability. Defaults to the V-3 threshold (0.7). */
  threshold?: number;
  concurrency?: number;
}

export interface ReportVerification {
  /** Verification of the final report. */
  verification: VerificationBlock;
  /** Verifier tokens. */
  usage: DecisionUsage;
  durationMs: number;
}

const gaps = (block: VerificationBlock) => block.entries.filter(entry => entry.verdict === 'not_covered');

/** V-9: coverage entries flagged, as report items. Built by code from the verdicts, in evidence order. */
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

/** One verifier per report: call `finish` with the report the writer returned. It checks once and never changes the writer's text. */
export function createReportVerifier(impacts: EntityImpact[], options: ReportVerifierOptions) {
  const verifyId = randomUUID();

  return {
    verifyId,
    /** Checks the report and adds the deterministic "Not covered" list (V-9). */
    async finish(report: ImpactReport): Promise<{ report: ImpactReport; verification: ReportVerification }> {
      const startedAt = Date.now();
      const result = await verifyReport({
        client: options.client,
        impacts,
        report,
        threshold: options.threshold,
        concurrency: options.concurrency,
        priorState: options.priorState,
        cacheKey: verifyId,
      });
      const flagged = gaps(result.verification);
      const notCovered = buildNotCovered(result.verification, impacts);
      const durationMs = Date.now() - startedAt;
      logLLMTrace('verifier.completed', {
        verifyId,
        questions: result.verification.entries.length,
        threshold: result.verification.threshold,
        coverageGaps: flagged.filter(entry => entry.kind === 'coverage').length,
        faithfulnessFlags: flagged.filter(entry => entry.kind === 'faithfulness').length,
        notCovered: notCovered.length,
        durationMs,
        usage: result.usage,
        scores: result.verification.entries.map(entry => ({ id: entry.id, score: entry.score, verdict: entry.verdict, reason: entry.reason })),
      });
      return {
        report: withNotCovered(report, notCovered),
        verification: { verification: result.verification, usage: result.usage, durationMs },
      };
    },
  };
}
