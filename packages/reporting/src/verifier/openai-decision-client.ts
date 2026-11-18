import {
  addUsage,
  EMPTY_USAGE,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionClient,
  type DecisionQuestion,
  type DecisionResult,
} from './decision-client';

export const OPENAI_DECISIONS_MODEL = 'gpt-6-luna';
const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';
/** The API accepts at most 400 questions per call. */
export const MAX_QUESTIONS_PER_CALL = 400;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];

export interface OpenAIDecisionClientOptions {
  /** Direct OpenAI key. OpenRouter does not proxy /v1/decisions (ADR-0011), so this is separate from OPENROUTER_API_KEY. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`OpenAI Decisions HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

const isRetryable = (error: unknown) => (error instanceof HttpError ? error.status === 429 || error.status >= 500 : !(error instanceof Error && error.name === 'AbortError'));

export function createOpenAIDecisionClient(options: OpenAIDecisionClientOptions = {}): DecisionClient {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set. The verifier needs its own OpenAI key (OpenRouter does not proxy /v1/decisions).');
  const model = options.model ?? OPENAI_DECISIONS_MODEL;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  async function post(input: string, questions: DecisionQuestion[], decideOptions: DecideOptions) {
    const body = JSON.stringify({
      model,
      input,
      // `name` is an index, so the caller's ids never have to satisfy the API's naming rules.
      questions: questions.map((question, index) => ({ type: 'predicate', name: `q${index}`, instructions: question.instructions })),
      ...(decideOptions.cacheKey ? { prompt_cache_key: decideOptions.cacheKey } : {}),
    });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const signal = decideOptions.signal
          ? AbortSignal.any([decideOptions.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
          : AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const response = await doFetch(OPENAI_DECISIONS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body,
          signal,
        });
        const text = await response.text();
        if (!response.ok) throw new HttpError(response.status, text);
        return JSON.parse(text) as any;
      } catch (error) {
        const delay = delays[attempt];
        // A timeout is an AbortError/TimeoutError and is not retried: the verifier must not stall report generation.
        if (delay === undefined || !isRetryable(error) || (error instanceof Error && error.name === 'TimeoutError')) throw error;
        await sleep(delay);
      }
    }
  }

  async function decideBatch(input: string, questions: DecisionQuestion[], decideOptions: DecideOptions): Promise<DecisionResult> {
    try {
      const out = await post(input, questions, decideOptions);
      const returned: any[] = Array.isArray(out.answers) ? out.answers : [];
      const answers: DecisionAnswer[] = [];
      questions.forEach((question, index) => {
        const raw = returned.find(a => a?.name === `q${index}`) ?? (returned.every(a => a?.name === undefined) ? returned[index] : undefined);
        if (raw?.type === 'predicate' && typeof raw.probability === 'number' && raw.probability >= 0 && raw.probability <= 1) answers.push({ id: question.id, outcome: 'answer', probability: raw.probability });
        else if (raw?.type === 'refusal') answers.push({ id: question.id, outcome: 'refusal' });
        else if (raw) answers.push({ id: question.id, outcome: 'error', message: `Unexpected answer type ${String(raw.type)}` });
        // No raw answer: leave it out. The verdict policy reports it as missing.
      });
      return {
        answers,
        model: String(out.model ?? model),
        usage: {
          inputTokens: out.usage?.input_tokens ?? 0,
          cachedTokens: out.usage?.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: out.usage?.output_tokens ?? 0,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
      return { answers: questions.map(question => ({ id: question.id, outcome: 'error' as const, message })), model, usage: EMPTY_USAGE };
    }
  }

  return {
    async decide(input, questions, decideOptions = {}) {
      let merged: DecisionResult = { answers: [], usage: EMPTY_USAGE, model };
      // Above 400 questions the call is split. Every part carries the same input and cache key, so the prefix is cached after the first part.
      for (let start = 0; start < questions.length; start += MAX_QUESTIONS_PER_CALL) {
        const part = await decideBatch(input, questions.slice(start, start + MAX_QUESTIONS_PER_CALL), decideOptions);
        merged = { answers: [...merged.answers, ...part.answers], usage: addUsage(merged.usage, part.usage), model: part.model };
      }
      return merged;
    },
  };
}
