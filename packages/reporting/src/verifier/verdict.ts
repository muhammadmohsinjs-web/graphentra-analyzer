import type { DecisionAnswer } from './decision-client';
import type { VerificationItem, VerificationKind } from './questions';

// Phase V (ADR-0011), V-6. Chosen at V-3 on the labelled set: flag when p < 0.7 (recall 92 %, precision 92 %).
export const DEFAULT_THRESHOLD = 0.7;

/** `no_behaviour_change` (V-13b): skipped by the deterministic filter, never asked. */
export type VerdictReason = 'ok' | 'low_score' | 'refusal' | 'error' | 'missing' | 'no_behaviour_change';

export interface VerificationEntry {
  id: string;
  kind: VerificationKind;
  /** Coverage: the changed entity. */
  entity?: string;
  /** Coverage (V-13b): this inner function was folded into the question for this entity and takes its verdict. */
  foldedInto?: string;
  /** Faithfulness: the claim. */
  claim?: string;
  /** Probability that the answer is "yes". Null when there is no usable answer. */
  score: number | null;
  /** `skipped` (V-13b): the change has no runtime effect, so there was nothing to cover. */
  verdict: 'covered' | 'not_covered' | 'skipped';
  reason: VerdictReason;
}

export interface VerificationBlock {
  threshold: number;
  /** Every changed production entity appears once (asked, folded or skipped), then every claim. */
  entries: VerificationEntry[];
  /** Questions answered "not covered" (folded inner functions are not counted again). */
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

export function buildVerificationBlock(
  items: VerificationItem[],
  answers: Map<string, DecisionAnswer>,
  threshold = DEFAULT_THRESHOLD,
  skipped: string[] = [],
): VerificationBlock {
  const asked = items.map(item => judgeAnswer(item, answers.get(item.id), threshold));
  const entries: VerificationEntry[] = [];
  asked.forEach((entry, index) => {
    entries.push(entry);
    for (const child of items[index].covers ?? [])
      entries.push({ id: `coverage:${child}`, kind: 'coverage', entity: child, foldedInto: entry.entity, score: entry.score, verdict: entry.verdict, reason: entry.reason });
  });
  // Skipped entities go after the asked coverage entries and before the claims, so the order stays stable.
  const firstClaim = entries.findIndex(entry => entry.kind === 'faithfulness');
  const skippedEntries = skipped.map(entity => ({ id: `coverage:${entity}`, kind: 'coverage' as const, entity, score: null, verdict: 'skipped' as const, reason: 'no_behaviour_change' as const }));
  entries.splice(firstClaim < 0 ? entries.length : firstClaim, 0, ...skippedEntries);
  return { threshold, entries, notCovered: asked.filter(entry => entry.verdict === 'not_covered').length };
}
