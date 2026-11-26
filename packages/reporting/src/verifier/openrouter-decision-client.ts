import {
  addUsage,
  EMPTY_USAGE,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionClient,
  type DecisionQuestion,
  type DecisionResult,
} from './decision-client';

/**
 * Phase V, eval-only route: the same verifier questions answered by the report model (Luna) through OpenRouter's chat
 * completions, instead of the OpenAI Decisions API. The Decisions API is the production route (see openai-decision-client.ts).
 *
 * Differences that matter for reading results:
 * - The probability is the model's own reply (JSON), not a calibrated score from the Decisions API. DEFAULT_THRESHOLD (0.7) was
 *   tuned on Decisions answers, so recall and precision here can differ from the production numbers.
 * - A chat reply has no refusal outcome; an unparseable reply is reported as `error` for every question in that call.
 */
export const OPENROUTER_DECISIONS_MODEL = 'openai/gpt-6-luna';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Same cap per call as the Decisions route, so a question set is split the same way. */
export const MAX_QUESTIONS_PER_OPENROUTER_CALL = 400;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];

export interface OpenRouterDecisionClientOptions {
  /** OpenRouter key. Defaults to OPENROUTER_API_KEY. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const SYSTEM_PROMPT = [
  'You check a code change against a list of statements.',
  'For each statement q0, q1, ... give the probability (0 to 1) that it is true of the input.',
  'Reply with JSON only, in this shape: {"answers":[{"name":"q0","probability":0.93}, ...]}, one entry per statement.',
].join(' ');

class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`OpenRouter HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

const isRetryable = (error: unknown) => (error instanceof HttpError ? error.status === 429 || error.status >= 500 : !(error instanceof Error && error.name === 'AbortError'));

/** The reply's answers by statement name. Accepts a bare JSON object or one wrapped in a code fence. */
export function parseOpenRouterAnswers(content: string): Map<string, number | 'bad'> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('reply has no JSON object');
  const parsed = JSON.parse(content.slice(start, end + 1)) as { answers?: unknown };
  if (!Array.isArray(parsed.answers)) throw new Error('reply has no answers array');
  const out = new Map<string, number | 'bad'>();
  for (const raw of parsed.answers as Array<{ name?: unknown; probability?: unknown }>) {
    if (typeof raw?.name !== 'string') continue;
    const p = raw.probability;
    out.set(raw.name, typeof p === 'number' && p >= 0 && p <= 1 ? p : 'bad');
  }
  return out;
}

export function createOpenRouterDecisionClient(options: OpenRouterDecisionClientOptions = {}): DecisionClient {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set. The OpenRouter verifier route needs it.');
  const model = options.model ?? OPENROUTER_DECISIONS_MODEL;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  async function post(input: string, questions: DecisionQuestion[], decideOptions: DecideOptions) {
    const statements = questions.map((question, index) => `q${index}: ${question.instructions}`).join('\n');
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        // The input goes first so calls that share it share a cached prefix.
        { role: 'user', content: `${input}\n\nStatements:\n${statements}` },
      ],
      response_format: { type: 'json_object' },
      // Room for one short entry per statement (reasoning tokens count against this too).
      max_tokens: Math.min(32_000, 2_000 + questions.length * 60),
    });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const signal = decideOptions.signal
          ? AbortSignal.any([decideOptions.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
          : AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const response = await doFetch(OPENROUTER_URL, {
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
        // A timeout is not retried: the verifier must not stall report generation.
        if (delay === undefined || !isRetryable(error) || (error instanceof Error && error.name === 'TimeoutError')) throw error;
        await sleep(delay);
      }
    }
  }

  async function decideBatch(input: string, questions: DecisionQuestion[], decideOptions: DecideOptions): Promise<DecisionResult> {
    try {
      const out = await post(input, questions, decideOptions);
      const content = out?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('empty reply');
      const byName = parseOpenRouterAnswers(content);
      const answers: DecisionAnswer[] = [];
      questions.forEach((question, index) => {
        const value = byName.get(`q${index}`);
        if (typeof value === 'number') answers.push({ id: question.id, outcome: 'answer', probability: value });
        else if (value === 'bad') answers.push({ id: question.id, outcome: 'error', message: 'probability outside 0..1' });
        // No entry for this statement: leave it out. The verdict policy reports it as missing.
      });
      const usage = out.usage ?? {};
      return {
        answers,
        model: String(out.model ?? model),
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
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
      for (let start = 0; start < questions.length; start += MAX_QUESTIONS_PER_OPENROUTER_CALL) {
        const part = await decideBatch(input, questions.slice(start, start + MAX_QUESTIONS_PER_OPENROUTER_CALL), decideOptions);
        merged = { answers: [...merged.answers, ...part.answers], usage: addUsage(merged.usage, part.usage), model: part.model };
      }
      return merged;
    },
  };
}
