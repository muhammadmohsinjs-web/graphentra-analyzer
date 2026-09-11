import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import OpenAI, { APIError, type ClientOptions } from 'openai';
import { z } from 'zod';

config({ path: ['.env', '../.env'], quiet: true });

export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5.6-luna';

const impactReportSchema = z
  .object({
    summary: z.string().trim(),
    keyChanges: z.array(z.string().trim()).min(1).max(5),
    qaChecks: z.array(z.string().trim()).min(1).max(5),
    uncertainty: z.array(z.string().trim()).max(1),
  })
  .strict();

export type ImpactReport = z.infer<typeof impactReportSchema>;

export function validateImpactReportSemantics(report: ImpactReport): string[] {
  const errors: string[] = [];
  const fields: [string, string][] = [
    ['summary', report.summary],
    ...report.keyChanges.map((value, index): [string, string] => [`keyChanges[${index}]`, value]),
    ...report.qaChecks.map((value, index): [string, string] => [`qaChecks[${index}]`, value]),
    ...report.uncertainty.map((value, index): [string, string] => [`uncertainty[${index}]`, value]),
  ];
  const heading = /^(?:qa\s+(?:report|change)\b|what\s+changed\b|(?:summary|change|impact|key\s*changes|qa\s*checks|uncertainty|title|overview|checks|risks?|notes?)\s*(?::|$))/i;
  const markdown = /[\r\n\u2028\u2029`#]|^\s*(?:>|[-+*]\s|\d+[.)]\s)|\*\*|__[^_\s].*?__|~~|\*[^*\s][^*]*\*|(?:^|\s)_[^_\s][^_]*_(?=\s|[.,!?]|$)|!?\[[^\]]*\]\s*\([^)]*\)|<\/?[a-z][^>]*>|^\|.*\|$/i;
  const technicalIdentifier = /(?:\b[a-z]{2,}[A-Z][A-Za-z0-9_$]*\b|\b[^\s]+\.(?:ts|tsx|mts|cts)\b)/;
  const implementationTask = /\b(?:test suite|test expectations?|unit tests?|integration tests?|source code|inline comment|code comment|edit the code|update the code|update the comment|change the code)\b/i;

  for (const [field, value] of fields) {
    const text = value.trim();

    if (!text) {
      errors.push(`${field} must not be empty.`);
      continue;
    }

    if (heading.test(text) || markdown.test(text)) {
      errors.push(`${field} must be plain text without headings, field labels, Markdown, or line breaks.`);
    }

    if (technicalIdentifier.test(text)) {
      errors.push(`${field} must not include source file names or technical entity identifiers.`);
    }

    if (field === 'summary' || field.startsWith('keyChanges[')) {
      if (!/[.!?][)'"\]]*$/.test(text)) {
        errors.push(`${field} must be a complete sentence ending with a period, question mark, or exclamation mark.`);
      }
    }

    if (field.startsWith('qaChecks[')) {
      if (!/^(verify|check|confirm|validate|test|ensure)\b/i.test(text)) {
        errors.push(`${field} must start with Verify, Check, Confirm, Validate, Test, or Ensure and describe a specific action.`);
      }

      if (implementationTask.test(text)) {
        errors.push(`${field} must verify runtime behavior, not inspect or update source code, comments, or automated tests.`);
      }
    }
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
    'QA checks:',
    ...report.qaChecks.map(check => `- ${check}`),
  ];

  if (report.uncertainty.length > 0) {
    lines.push('', 'Uncertainty:', ...report.uncertainty.map(item => `- ${item}`));
  }

  return lines.join('\n');
}

interface GenerateImpactReportInput {
  instruction: string;
  evidence: unknown;
}

type OpenAILogLevel = NonNullable<ClientOptions['logLevel']>;

const openAILogLevels = new Set<OpenAILogLevel>(['off', 'error', 'warn', 'info', 'debug']);
const transportRetryDelaysMs = [500, 1500];
const transientTransportCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH']);

function isTransientTransportError(error: unknown): boolean {
  // APIError failures have already gone through the SDK's status/connection retry policy.
  if (error instanceof APIError) {
    return false;
  }

  const seen = new Set<unknown>();
  let current = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error && /\b(?:terminated|fetch failed|socket hang up)\b/i.test(current.message)) {
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

      console.warn(`[llm] Connection dropped while reading the response; retrying (${attempt + 2}/${transportRetryDelaysMs.length + 1}) in ${delayMs}ms.`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

function getOpenAILogLevel(): OpenAILogLevel {
  const configuredLevel = process.env.OPENAI_LOG?.toLowerCase();

  if (!configuredLevel) {
    return 'info';
  }

  if (openAILogLevels.has(configuredLevel as OpenAILogLevel)) {
    return configuredLevel as OpenAILogLevel;
  }

  console.warn(`[llm] Ignoring invalid OPENAI_LOG value "${configuredLevel}"; using "info".`);

  return 'info';
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

function createOpenRouterClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is required to generate an impact report.');
  }

  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    logLevel: getOpenAILogLevel(),
  });
}

export async function generateImpactReport({ instruction, evidence }: GenerateImpactReportInput): Promise<ImpactReport> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const serializedEvidence = JSON.stringify(evidence, null, 2);
  let attempt = 1;

  logLLMTrace('request.started', {
    traceId,
    provider: 'openrouter',
    model: OPENROUTER_MODEL,
    evidenceBytes: Buffer.byteLength(serializedEvidence),
  });

  try {
    const client = createOpenRouterClient();
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system',
          content: instruction,
        },
        {
          role: 'user',
          content: `Generate one concise, unified plain-English QA change-impact report for all supplied changes. Merge related changes, preserve precise quantities, prioritize QA-visible behavior, and do not infer user-facing surfaces.\n\n${serializedEvidence}`,
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
                description: 'Exactly one concise, complete sentence summarizing the overall release impact. Do not repeat the detailed bullets, name functions, files, or entity IDs, or use headings, labels, Markdown, or report titles.',
              },
              keyChanges: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'string',
                  description: 'One concise, complete sentence combining a key behavior change with its QA-visible consequence. Merge closely related changes and omit implementation-only details with no runtime effect. Do not name functions, files, or entity IDs. Plain text only.',
                },
              },
              qaChecks: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'string',
                  description: 'Start with Verify, Check, Confirm, Validate, Test, or Ensure. Check the specific changed runtime behavior using only supplied evidence/context. Do not ask QA to inspect or update code/comments, run/update automated tests, or test unrelated existing behavior. Do not name source files or entity IDs. Plain text only, no headings, labels, or Markdown.',
                },
              },
              uncertainty: {
                type: 'array',
                maxItems: 1,
                items: {
                  type: 'string',
                  description: 'The single most important genuine uncertainty, in simple non-technical plain text. Do not invent risks or add generic disclaimers; use an empty array when nothing material is uncertain. No headings, field labels, or Markdown.',
                },
              },
            },
            required: ['summary', 'keyChanges', 'qaChecks', 'uncertainty'],
            additionalProperties: false,
          },
        },
      },
    };

    for (; attempt <= 2; attempt += 1) {
      const { data: completion, request_id: requestId } = await withTransportRetries(() =>
        client.chat.completions
          .create(
            request,
            {
              headers: {
                'X-Client-Request-Id': traceId,
              },
            },
          )
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
        throw new Error('The LLM returned an impact report that was not valid JSON.', { cause: error });
      }

      const validatedReport = impactReportSchema.parse(report);
      const errors = validateImpactReportSemantics(validatedReport);

      if (errors.length > 0) {
        if (attempt >= 2) {
          throw new Error(`The LLM returned a semantically invalid impact report after ${attempt} attempts: ${errors.join(' ')}`);
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
            content: `Correct the previous report using only the same evidence above. Return the complete JSON object matching the schema. Fix these validation errors:\n${errors.join('\n')}\nProduce one unified report, merge related changes, and avoid repeating the same point across fields. Use exactly one concise, complete summary sentence and one complete sentence per key change. Finish each thought naturally and end it with sentence punctuation. Treat removedCode as BEFORE and addedCode as AFTER; do not reverse them. All fields must be nonempty plain text without headings, labels, Markdown, source file names, function names, entity IDs, or line breaks. Start every QA check with Verify, Check, Confirm, Validate, Test, or Ensure and test the specific changed runtime behavior. Do not ask QA to inspect/update code or comments, run/update automated tests, or test unrelated behavior. Include at most one material uncertainty; otherwise use an empty uncertainty array.`,
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
      model: OPENROUTER_MODEL,
      attempt,
      durationMs: Date.now() - startedAt,
      ...describeError(error),
    });

    throw error;
  }
}
