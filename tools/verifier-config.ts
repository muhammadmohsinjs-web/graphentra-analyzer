// Phase V rollout (V-14, V-15): report-server config for the verifier and the signals it stores per report.
// Pure functions, so the server stays thin and these can be tested without a network or a database.
import { DEFAULT_THRESHOLD, type ReportVerification } from '@graphentra/reporting';

export type VerifierConfig = { enabled: false } | { enabled: true; apiKey: string; threshold: number };

/**
 * V-14: the verifier is opt-in on the server too (ADR-0011). `GRAPHENTRA_VERIFY_REPORT=1` switches it on, the same
 * switch as `npm run report -- --verify`. It needs a direct `OPENAI_API_KEY` (OpenRouter does not proxy /v1/decisions).
 * `GRAPHENTRA_VERIFIER_THRESHOLD` overrides the V-3 threshold (0.7). Bad config throws, so the server fails at start,
 * not on the first report.
 */
export function readVerifierConfig(environment: NodeJS.ProcessEnv): VerifierConfig {
  if (environment.GRAPHENTRA_VERIFY_REPORT !== '1') return { enabled: false };
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('GRAPHENTRA_VERIFY_REPORT=1 needs OPENAI_API_KEY (a direct OpenAI key; OpenRouter does not proxy /v1/decisions).');
  const raw = environment.GRAPHENTRA_VERIFIER_THRESHOLD?.trim();
  const threshold = raw ? Number(raw) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new Error(`GRAPHENTRA_VERIFIER_THRESHOLD must be a number between 0 and 1 (exclusive), got "${raw}".`);
  }
  return { enabled: true, apiKey, threshold };
}

/** What the server stores per verified report. Counts and scores only: no question text, no code. */
export interface VerificationSummary {
  threshold: number;
  questions: number;
  /** Questions with a probability. */
  answered: number;
  notCovered: number;
  coverageGaps: number;
  faithfulnessFlags: number;
  skipped: number;
  refusals: number;
  errors: number;
  missing: number;
  /** Over answered questions; null when none was answered. */
  meanScore: number | null;
  minScore: number | null;
  durationMs: number;
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number };
  plainChecks?: { checks: number; fallback: number; untestable: number; promptTokens: number; completionTokens: number; durationMs: number; failed: boolean };
}

export function summarizeVerification(result: ReportVerification): VerificationSummary {
  const { entries, threshold } = result.verification;
  // A folded inner function copies its ancestor's answer, and a skipped change was never asked: neither is a question.
  const asked = entries.filter(entry => !entry.foldedInto && entry.verdict !== 'skipped');
  const scores = asked.map(entry => entry.score).filter((score): score is number => typeof score === 'number');
  const flagged = asked.filter(entry => entry.verdict === 'not_covered');
  const count = (reason: string) => asked.filter(entry => entry.reason === reason).length;
  const plain = result.plainChecks;
  return {
    threshold,
    questions: asked.length,
    answered: scores.length,
    notCovered: result.verification.notCovered,
    coverageGaps: flagged.filter(entry => entry.kind === 'coverage').length,
    faithfulnessFlags: flagged.filter(entry => entry.kind === 'faithfulness').length,
    skipped: entries.filter(entry => entry.verdict === 'skipped').length,
    refusals: count('refusal'),
    errors: count('error'),
    missing: count('missing'),
    meanScore: scores.length ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
    minScore: scores.length ? round(Math.min(...scores)) : null,
    durationMs: result.durationMs,
    usage: { inputTokens: result.usage.inputTokens, cachedTokens: result.usage.cachedTokens, outputTokens: result.usage.outputTokens },
    ...(plain ? {
      plainChecks: {
        checks: plain.checks.length,
        fallback: plain.fallback.length,
        untestable: plain.untestable.length,
        promptTokens: plain.usage.promptTokens,
        completionTokens: plain.usage.completionTokens,
        durationMs: plain.durationMs,
        failed: Boolean(plain.error),
      },
    } : {}),
  };
}

/** V-15 (M6): verifier signals over many reports, for the dashboard. Reports without a summary count as unverified. */
export interface VerifierStats {
  reports: number;
  verifiedReports: number;
  /** Verified reports with at least one "Not covered" item. The V-8 repair round was removed at V-13, so this replaces "repair rate". */
  reportsWithGaps: number;
  gapRate: number | null;
  notCovered: { total: number; median: number | null; p90: number | null; max: number | null };
  /** Share of verified reports whose "Not covered" list has at most 3 items (E7 baseline target). */
  notCoveredAtMost3Rate: number | null;
  meanScore: number | null;
  refusals: number;
  errors: number;
  missing: number;
  /** Verified reports with at least one refusal, error or missing answer. */
  reportsWithFailedAnswers: number;
  durationMs: { p50: number | null; p95: number | null };
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; plainCheckPromptTokens: number; plainCheckCompletionTokens: number };
  plainCheckFailures: number;
}

export function verifierStats(reports: number, summaries: VerificationSummary[]): VerifierStats {
  const notCovered = summaries.map(summary => summary.notCovered);
  const scores = summaries.map(summary => summary.meanScore).filter((score): score is number => score !== null);
  const sum = (pick: (summary: VerificationSummary) => number) => summaries.reduce((total, summary) => total + pick(summary), 0);
  const rate = (part: number) => (summaries.length ? round(part / summaries.length) : null);
  const withGaps = notCovered.filter(count => count > 0).length;
  return {
    reports,
    verifiedReports: summaries.length,
    reportsWithGaps: withGaps,
    gapRate: rate(withGaps),
    notCovered: { total: sum(summary => summary.notCovered), median: percentile(notCovered, 50), p90: percentile(notCovered, 90), max: notCovered.length ? Math.max(...notCovered) : null },
    notCoveredAtMost3Rate: rate(notCovered.filter(count => count <= 3).length),
    meanScore: scores.length ? round(scores.reduce((total, score) => total + score, 0) / scores.length) : null,
    refusals: sum(summary => summary.refusals),
    errors: sum(summary => summary.errors),
    missing: sum(summary => summary.missing),
    reportsWithFailedAnswers: summaries.filter(summary => summary.refusals + summary.errors + summary.missing > 0).length,
    durationMs: { p50: percentile(summaries.map(summary => summary.durationMs), 50), p95: percentile(summaries.map(summary => summary.durationMs), 95) },
    usage: {
      inputTokens: sum(summary => summary.usage.inputTokens),
      cachedTokens: sum(summary => summary.usage.cachedTokens),
      outputTokens: sum(summary => summary.usage.outputTokens),
      plainCheckPromptTokens: sum(summary => summary.plainChecks?.promptTokens ?? 0),
      plainCheckCompletionTokens: sum(summary => summary.plainChecks?.completionTokens ?? 0),
    },
    plainCheckFailures: summaries.filter(summary => summary.plainChecks?.failed).length,
  };
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const round = (value: number) => Math.round(value * 1000) / 1000;
