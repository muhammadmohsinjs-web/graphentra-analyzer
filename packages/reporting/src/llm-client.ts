import { randomUUID } from 'crypto';
import OpenAI, { APIError, type ClientOptions } from 'openai';
import { z } from 'zod';

export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.6-luna';
export const OPENROUTER_MODEL = DEFAULT_OPENROUTER_MODEL;

export const testAreaSchema = z
  .object({
    area: z.string().trim(),
    surfaceIds: z.array(z.string().trim()),
    howToReach: z.string().trim(),
    access: z.string().trim(),
    setup: z.string().trim(),
    checks: z.array(z.string().trim()).min(1).max(4),
  })
  .strict();

export type TestArea = z.infer<typeof testAreaSchema>;

/** Normalized report: `qaChecks` is always present (derived from testAreas when needed). */
export const impactReportSchema = z
  .object({
    summary: z.string().trim(),
    keyChanges: z.array(z.string().trim()).min(1).max(5),
    qaChecks: z.array(z.string().trim()).min(1).max(5),
    uncertainty: z.array(z.string().trim()).max(1),
    testAreas: z.array(testAreaSchema).min(1).max(5).optional(),
  })
  .strict();

/** Provider response: either legacy qaChecks or testAreas (preferred). */
const impactReportResponseSchema = z
  .object({
    summary: z.string().trim(),
    keyChanges: z.array(z.string().trim()).min(1).max(5),
    qaChecks: z.array(z.string().trim()).min(1).max(5).optional(),
    uncertainty: z.array(z.string().trim()).max(1),
    testAreas: z.array(testAreaSchema).min(1).max(5).optional(),
  })
  .strict()
  .refine(report => Boolean(report.qaChecks?.length || report.testAreas?.length), 'Either qaChecks or testAreas is required.')
  .transform(report => ({
    summary: report.summary,
    keyChanges: report.keyChanges,
    qaChecks: report.qaChecks ?? report.testAreas!.flatMap(area => area.checks).slice(0, 5),
    uncertainty: report.uncertainty,
    ...(report.testAreas ? { testAreas: report.testAreas } : {}),
  }));

export type ImpactReport = z.infer<typeof impactReportSchema>;

/** User-visible routes (`/checkout`, `POST /api/orders/:id`) are allowed in report text. */
const ROUTE_TOKEN = /(^|[\s('"])(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+)?\/[\w\-./:[\]{}]*/g;

export function validateImpactReportSemantics(report: ImpactReport, options: { allowedSurfaceIds?: string[] } = {}): string[] {
  const errors: string[] = [];
  const areas = report.testAreas ?? [];
  const fields: [string, string][] = [
    ['summary', report.summary],
    ...report.keyChanges.map((value, index): [string, string] => [`keyChanges[${index}]`, value]),
    ...(areas.length ? [] : report.qaChecks.map((value, index): [string, string] => [`qaChecks[${index}]`, value])),
    ...report.uncertainty.map((value, index): [string, string] => [`uncertainty[${index}]`, value]),
    ...areas.flatMap((area, index): [string, string][] => [
      [`testAreas[${index}].area`, area.area],
      [`testAreas[${index}].howToReach`, area.howToReach],
      [`testAreas[${index}].access`, area.access],
      [`testAreas[${index}].setup`, area.setup],
      ...area.checks.map((check, checkIndex): [string, string] => [`testAreas[${index}].checks[${checkIndex}]`, check]),
    ]),
  ];
  const heading =
    /^(?:qa\s+(?:report|change)\b|what\s+changed\b|(?:summary|change|impact|key\s*changes|qa\s*checks|uncertainty|title|overview|checks|risks?|notes?)\s*(?::|$))/i;
  const markdown =
    /[\r\n\u2028\u2029`#]|^\s*(?:>|[-+*]\s|\d+[.)]\s)|\*\*|__[^_\s].*?__|~~|\*[^*\s][^*]*\*|(?:^|\s)_[^_\s][^_]*_(?=\s|[.,!?]|$)|!?\[[^\]]*\]\s*\([^)]*\)|<\/?[a-z][^>]*>|^\|.*\|$/i;
  const technicalIdentifier = /\b[a-z]{2,}[A-Z][A-Za-z0-9_$]*\b/;
  const sourceFileName = /\b[^\s]+\.(?:ts|tsx|mts|cts)\b/;
  const implementationTask =
    /\b(?:test suite|test expectations?|unit tests?|integration tests?|source code|inline comment|code comment|edit the code|update the code|update the comment|change the code)\b/i;

  for (const [field, value] of fields) {
    const text = value.trim();
    const isCheck = field.startsWith('qaChecks[') || /\.checks\[/.test(field);

    if (!text) {
      errors.push(`${field} must not be empty.`);
      continue;
    }

    if (heading.test(text) || markdown.test(text)) {
      errors.push(
        `${field} must be plain text without headings, field labels, Markdown, or line breaks.`,
      );
    }

    if (technicalIdentifier.test(text.replace(ROUTE_TOKEN, '$1')) || sourceFileName.test(text)) {
      errors.push(
        `${field} must not include source file names or technical entity identifiers.`,
      );
    }

    if (field === 'summary' || field.startsWith('keyChanges[')) {
      if (!/[.!?][)'"\]]*$/.test(text)) {
        errors.push(
          `${field} must be a complete sentence ending with a period, question mark, or exclamation mark.`,
        );
      }
    }

    if (isCheck) {
      if (!/^(verify|check|confirm|validate|test|ensure)\b/i.test(text)) {
        errors.push(
          `${field} must start with Verify, Check, Confirm, Validate, Test, or Ensure and describe a specific action.`,
        );
      }

      if (implementationTask.test(text)) {
        errors.push(
          `${field} must verify runtime behavior, not inspect or update source code, comments, or automated tests.`,
        );
      }
    }
  }

  if (options.allowedSurfaceIds) {
    const allowed = new Set(options.allowedSurfaceIds);
    areas.forEach((area, index) => {
      for (const id of area.surfaceIds) {
        if (!allowed.has(id)) errors.push(`testAreas[${index}].surfaceIds contains unknown surface ${id}; use only supplied affectedAreas IDs or [].`);
      }
    });
  }

  return errors;
}

export function formatImpactReport(report: ImpactReport): string {
  const lines = [
    `Summary: ${report.summary}`,
    '',
    'Key changes:',
    ...report.keyChanges.map(change => `- ${change}`),
    '',
  ];

  if (report.testAreas?.length) {
    lines.push('Where and what to test:');
    report.testAreas.forEach((area, index) => {
      lines.push(
        '',
        `${index + 1}. ${area.area}${area.surfaceIds.length ? '' : ' (location inferred; no route found in code)'}`,
        `   How to reach: ${area.howToReach}`,
        `   Access: ${area.access}`,
        `   Setup: ${area.setup}`,
        '   Checks:',
        ...area.checks.map(check => `   - ${check}`),
      );
    });
  } else {
    lines.push('QA checks:', ...report.qaChecks.map(check => `- ${check}`));
  }

  if (report.uncertainty.length > 0) {
    lines.push('', 'Uncertainty:', ...report.uncertainty.map(item => `- ${item}`));
  }

  return lines.join('\n');
}

export interface LLMClientOptions {
  client?: OpenAI;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  logLevel?: ClientOptions['logLevel'];
}

export interface GenerateImpactReportInput {
  instruction: string;
  evidence: unknown;
  client?: OpenAI;
  options?: LLMClientOptions;
  /** Surface IDs the report may cite; unknown IDs trigger a correction. */
  allowedSurfaceIds?: string[];
}

type OpenAILogLevel = NonNullable<ClientOptions['logLevel']>;

const openAILogLevels = new Set<OpenAILogLevel>([
  'off',
  'error',
  'warn',
  'info',
  'debug',
]);
const transportRetryDelaysMs = [500, 1500];
const transientTransportCodes = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function isTransientTransportError(error: unknown): boolean {
  if (error instanceof APIError) {
    return false;
  }

  const seen = new Set<unknown>();
  let current = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (
      current instanceof Error &&
      /\b(?:terminated|fetch failed|socket hang up)\b/i.test(current.message)
    ) {
      return true;
    }

    if (typeof current !== 'object') {
      return false;
    }

    const details = current as { cause?: unknown; code?: unknown };
    if (typeof details.code === 'string' && transientTransportCodes.has(details.code)) {
      return true;
    }

    current = details.cause;
  }

  return false;
}

export async function withTransportRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = transportRetryDelaysMs[attempt];

      if (delayMs === undefined || !isTransientTransportError(error)) {
        throw error;
      }

      console.warn(
        `[llm] Connection dropped while reading the response; retrying (${attempt + 2}/${transportRetryDelaysMs.length + 1}) in ${delayMs}ms.`,
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

function logLLMTrace(event: string, details: Record<string, unknown>): void {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      scope: 'llm',
      event,
      ...details,
    }),
  );
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof APIError) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      status: error.status,
      requestId: error.requestID,
      errorCode: error.code,
    };
  }

  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorMessage: String(error),
  };
}

export function createOpenRouterClient(options?: LLMClientOptions): OpenAI {
  if (options?.client) {
    return options.client;
  }
  const apiKey = options?.apiKey;

  if (!apiKey) {
    throw new Error(
      'An injected API key or client is required to generate an impact report.',
    );
  }

  return new OpenAI({
    apiKey,
    baseURL: options?.baseURL ?? 'https://openrouter.ai/api/v1',
    logLevel: options?.logLevel ?? 'off',
  });
}

export interface GenerateStructuredInput<T> {
  /** Short label used in traces, e.g. "context.module". */
  task: string;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  parse: (value: unknown) => T;
  /** Returns semantic errors; a non-empty result triggers one correction request. */
  validate?: (value: T) => string[];
  options?: LLMClientOptions;
  /** Accept the corrected answer even if errors remain (callers then repair or drop invalid items). */
  acceptRemainingErrors?: boolean;
}

/** Strict-JSON-schema completion with transport retries, one semantic correction, and tracing. */
export async function generateStructured<T>(input: GenerateStructuredInput<T>): Promise<{ value: T; errors: string[] }> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const model = input.options?.model ?? DEFAULT_OPENROUTER_MODEL;
  const client = createOpenRouterClient(input.options);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: input.system },
    { role: 'user', content: input.user },
  ];
  logLLMTrace('structured.started', { traceId, task: input.task, model, inputBytes: Buffer.byteLength(input.user) });
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await withTransportRetries(() => client.chat.completions.create({
      model, messages: [...messages],
      response_format: { type: 'json_schema', json_schema: { name: input.schemaName, strict: true, schema: input.jsonSchema } },
    }, { headers: { 'X-Client-Request-Id': traceId } }));
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error(`The LLM returned no content for ${input.task}.`);
    let value: T;
    try { value = input.parse(JSON.parse(content)); }
    catch (error) { throw new Error(`The LLM returned invalid structured output for ${input.task}.`, { cause: error }); }
    lastErrors = input.validate?.(value) ?? [];
    if (!lastErrors.length || attempt === 2) {
      logLLMTrace('structured.completed', { traceId, task: input.task, model: completion.model ?? model, attempt,
        durationMs: Date.now() - startedAt, remainingErrors: lastErrors.length, usage: completion.usage });
      if (lastErrors.length && !input.acceptRemainingErrors) {
        throw new Error(`The LLM output for ${input.task} failed validation: ${lastErrors.slice(0, 5).join(' ')}`);
      }
      return { value, errors: lastErrors };
    }
    logLLMTrace('structured.semantic_retry', { traceId, task: input.task, attempt, errors: lastErrors.slice(0, 20) });
    messages.push(
      { role: 'assistant', content },
      { role: 'user', content: `Correct the previous answer using only the same input. Return the complete JSON object. Fix:\n${lastErrors.slice(0, 40).join('\n')}` },
    );
  }
  throw new Error(`The LLM correction limit was reached for ${input.task}.`);
}

export async function generateImpactReport({
  instruction,
  evidence,
  client: explicitClient,
  options,
  allowedSurfaceIds,
}: GenerateImpactReportInput): Promise<ImpactReport> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const serializedEvidence = JSON.stringify(evidence, null, 2);
  let attempt = 1;
  const targetModel = options?.model ?? DEFAULT_OPENROUTER_MODEL;

  logLLMTrace('request.started', {
    traceId,
    provider: 'openrouter',
    model: targetModel,
    evidenceBytes: Buffer.byteLength(serializedEvidence),
  });

  try {
    const client = explicitClient ?? options?.client ?? createOpenRouterClient(options);
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: targetModel,
      messages: [
        {
          role: 'system',
          content: instruction,
        },
        {
          role: 'user',
          content: `Generate one concise, unified plain-English QA change-impact report for all supplied changes. Merge related changes, preserve precise quantities, prioritize QA-visible behavior, tell the tester where to test and how to get there using only supplied application context, and do not infer user-facing surfaces that are not supplied.\n\n${serializedEvidence}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'qa_change_impact_report',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description:
                  'Exactly one concise, complete sentence summarizing the overall release impact. Do not repeat the detailed bullets, name functions, files, or entity IDs, or use headings, labels, Markdown, or report titles.',
              },
              keyChanges: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'string',
                  description:
                    'One concise, complete sentence combining a key behavior change with its QA-visible consequence. Merge closely related changes and omit implementation-only details with no runtime effect. Do not name functions, files, or entity IDs. Plain text only.',
                },
              },
              testAreas: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    area: { type: 'string', description: 'Business name of the page, API operation, or capability to test, from application context.' },
                    surfaceIds: { type: 'array', items: { type: 'string' }, description: 'IDs from applicationContext affectedAreas or usedByPages that this area covers; [] when none.' },
                    howToReach: { type: 'string', description: 'One sentence of navigation steps from context (menu and button labels in quotes; routes allowed). Say that navigation was not found in code when none is supplied.' },
                    access: { type: 'string', description: 'Who can use this area (role, sign-in requirement) from context, or that no restriction was found.' },
                    setup: { type: 'string', description: 'Accounts and test data needed before the checks, e.g. an order total of exactly 1.00.' },
                    checks: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 4,
                      items: {
                        type: 'string',
                        description:
                          'Start with Verify, Check, Confirm, Validate, Test, or Ensure. State the precise input and the expected visible outcome of the changed runtime behavior using only supplied evidence/context. Do not ask QA to inspect or update code/comments, run/update automated tests, or test unrelated existing behavior. Do not name source files or entity IDs. Plain text only.',
                      },
                    },
                  },
                  required: ['area', 'surfaceIds', 'howToReach', 'access', 'setup', 'checks'],
                },
              },
              uncertainty: {
                type: 'array',
                maxItems: 1,
                items: {
                  type: 'string',
                  description:
                    'The single most important genuine uncertainty, in simple non-technical plain text. Do not invent risks or add generic disclaimers; use an empty array when nothing material is uncertain. No headings, field labels, or Markdown.',
                },
              },
            },
            required: ['summary', 'keyChanges', 'testAreas', 'uncertainty'],
            additionalProperties: false,
          },
        },
      },
    };

    for (; attempt <= 2; attempt += 1) {
      const { data: completion, request_id: requestId } = await withTransportRetries(() =>
        client.chat.completions
          .create(request, {
            headers: {
              'X-Client-Request-Id': traceId,
            },
          })
          .withResponse(),
      );

      const content = completion.choices[0]?.message.content;

      if (!content) {
        throw new Error('The LLM returned an empty impact report.');
      }

      let report: unknown;

      try {
        report = JSON.parse(content);
      } catch (error) {
        throw new Error('The LLM returned an impact report that was not valid JSON.', {
          cause: error,
        });
      }

      const validatedReport = impactReportSchema.parse(impactReportResponseSchema.parse(report));
      const errors = validateImpactReportSemantics(validatedReport, { allowedSurfaceIds });

      if (errors.length > 0) {
        if (attempt >= 2) {
          throw new Error(
            `The LLM returned a semantically invalid impact report after ${attempt} attempts: ${errors.join(' ')}`,
          );
        }

        logLLMTrace('request.semantic_retry', {
          traceId,
          requestId,
          completionId: completion.id,
          provider: 'openrouter',
          model: completion.model,
          attempt,
          nextAttempt: attempt + 1,
          errors,
        });
        request.messages.push(
          { role: 'assistant', content },
          {
            role: 'user',
            content: `Correct the previous report using only the same evidence above. Return the complete JSON object matching the schema. Fix these validation errors:\n${errors.join('\n')}\nProduce one unified report, merge related changes, and avoid repeating the same point across fields. Use exactly one concise, complete summary sentence and one complete sentence per key change. Finish each thought naturally and end it with sentence punctuation. Treat removedCode as BEFORE and addedCode as AFTER; do not reverse them. All fields must be nonempty plain text without headings, labels, Markdown, source file names, function names, entity IDs, or line breaks. Start every QA check with Verify, Check, Confirm, Validate, Test, or Ensure and test the specific changed runtime behavior. Use only surfaceIds supplied in affectedAreas or usedByPages. Do not ask QA to inspect/update code or comments, run/update automated tests, or test unrelated behavior. Include at most one material uncertainty; otherwise use an empty uncertainty array.`,
          },
        );
        continue;
      }

      logLLMTrace('request.completed', {
        traceId,
        requestId,
        completionId: completion.id,
        provider: 'openrouter',
        model: completion.model,
        attempt,
        durationMs: Date.now() - startedAt,
        finishReason: completion.choices[0]?.finish_reason,
        usage: completion.usage,
      });

      return validatedReport;
    }
    throw new Error('The impact report correction limit was reached.');
  } catch (error) {
    logLLMTrace('request.failed', {
      traceId,
      provider: 'openrouter',
      model: targetModel,
      attempt,
      durationMs: Date.now() - startedAt,
      ...describeError(error),
    });

    throw error;
  }
}
