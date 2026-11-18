import type { DecisionAnswer } from './decision-client';
import type { VerificationItem, VerificationKind } from './questions';

// Phase V (ADR-0011), V-6. Chosen at V-3 on the labelled set: flag when p < 0.7 (recall 92 %, precision 92 %).
export const DEFAULT_THRESHOLD = 0.7;

export type VerdictReason = 'ok' | 'low_score' | 'refusal' | 'error' | 'missing';

export interface VerificationEntry {
  id: string;
  kind: VerificationKind;
  /** Coverage: the changed entity. */
  entity?: string;
  /** Faithfulness: the claim. */
  claim?: string;
  /** Probability that the answer is "yes". Null when there is no usable answer. */
  score: number | null;
  verdict: 'covered' | 'not_covered';
  reason: VerdictReason;
}

export interface VerificationBlock {
  threshold: number;
  entries: VerificationEntry[];
  notCovered: number;
}

/**
 * Recall-first (objective: never miss a bug). Only a clear "yes" is covered. A low score, a refusal, an error, a timeout
 * and an answer that never came back all count as "not covered", so a failing verifier can only add flags, never hide one.
 */
export function judgeAnswer(item: VerificationItem, answer: DecisionAnswer | undefined, threshold = DEFAULT_THRESHOLD): VerificationEntry {
  const base = { id: item.id, kind: item.kind, ...(item.entity ? { entity: item.entity } : {}), ...(item.claim ? { claim: item.claim } : {}) };
  if (!answer) return { ...base, score: null, verdict: 'not_covered', reason: 'missing' };
  if (answer.outcome === 'refusal') return { ...base, score: null, verdict: 'not_covered', reason: 'refusal' };
  if (answer.outcome === 'error') return { ...base, score: null, verdict: 'not_covered', reason: 'error' };
  const score = Number.isFinite(answer.probability) ? answer.probability : null;
  if (score === null) return { ...base, score: null, verdict: 'not_covered', reason: 'error' };
  return score >= threshold ? { ...base, score, verdict: 'covered', reason: 'ok' } : { ...base, score, verdict: 'not_covered', reason: 'low_score' };
}

export function buildVerificationBlock(items: VerificationItem[], answers: Map<string, DecisionAnswer>, threshold = DEFAULT_THRESHOLD): VerificationBlock {
  const entries = items.map(item => judgeAnswer(item, answers.get(item.id), threshold));
  return { threshold, entries, notCovered: entries.filter(entry => entry.verdict === 'not_covered').length };
}
