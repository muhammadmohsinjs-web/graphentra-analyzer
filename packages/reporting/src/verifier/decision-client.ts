// Phase V (ADR-0011): a yes/no "Decisions" API behind a small interface. Library code only, nothing here is called unless the verifier is switched on.

/** One yes/no question. `id` is the caller's key; it comes back unchanged on the answer. */
export interface DecisionQuestion {
  id: string;
  instructions: string;
}

/** Recall-first: only `answer` carries a score. Refusal and error both count as "not covered" in the verdict policy. */
export type DecisionAnswer =
  | { id: string; outcome: 'answer'; probability: number }
  | { id: string; outcome: 'refusal' }
  | { id: string; outcome: 'error'; message: string };

export interface DecisionUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface DecisionResult {
  /** Answers the service returned. A question can be missing here; the verdict policy treats that as "not covered". */
  answers: DecisionAnswer[];
  usage: DecisionUsage;
  model: string;
}

export interface DecideOptions {
  /** Same key for calls that share an input prefix, so the provider can cache it. */
  cacheKey?: string;
  signal?: AbortSignal;
}

export interface DecisionClient {
  /** Asks every question about one shared input. Does not throw for provider failures: they come back as `error` answers. */
  decide(input: string, questions: DecisionQuestion[], options?: DecideOptions): Promise<DecisionResult>;
}

export const EMPTY_USAGE: DecisionUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };

export function addUsage(a: DecisionUsage, b: DecisionUsage): DecisionUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
