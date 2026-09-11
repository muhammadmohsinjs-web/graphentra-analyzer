import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import OpenAI, { APIError, type ClientOptions } from 'openai';
import { z } from 'zod';

config({ path: ['.env', '../.env'], quiet: true });

export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5.6-luna';

const impactReportSchema = z
  .object({
    summary: z.string().max(240).trim(),
    impact: z.string().max(240).trim(),
    qaChecks: z.array(z.string().max(200).trim()).min(1).max(5),
    uncertainty: z.array(z.string().max(200).trim()).max(2),
  })
  .strict();

export type ImpactReport = z.infer<typeof impactReportSchema>;

export function validateImpactReportSemantics(report: ImpactReport): string[] {
  const errors: string[] = [];
  const fields: [string, string][] = [
    ['summary', report.summary],
    ['impact', report.impact],
    ...report.qaChecks.map((value, index): [string, string] => [`qaChecks[${index}]`, value]),
    ...report.uncertainty.map((value, index): [string, string] => [`uncertainty[${index}]`, value]),
  ];
  const heading = /^(?:qa\s+(?:report|change)\b|what\s+changed\b|(?:summary|change|impact|qa\s*checks|uncertainty|title|overview|checks|risks?|notes?)\s*(?::|$))/i;
  const markdown = /[\r\n\u2028\u2029`]|^\s*(?:#|>|[-+*]\s|\d+[.)]\s)|\*\*|__[^_\s].*?__|~~|\*[^*\s][^*]*\*|(?:^|\s)_[^_\s][^_]*_(?=\s|[.,!?]|$)|!?\[[^\]]*\]\s*\([^)]*\)|<\/?[a-z][^>]*>|^\|.*\|$/i;

  for (const [field, value] of fields) {
    const text = value.trim();

    if (!text) {
      errors.push(`${field} must not be empty.`);
      continue;
    }

    if (heading.test(text) || markdown.test(text)) {
      errors.push(`${field} must be plain text without headings, field labels, Markdown, or line breaks.`);
    }

    if (field.startsWith('qaChecks[') && !/^(verify|check|confirm|validate|test|ensure)\b/i.test(text)) {
      errors.push(`${field} must start with Verify, Check, Confirm, Validate, Test, or Ensure and describe a specific action.`);
    }
  }

  return errors;
}

export function formatImpactReport(report: ImpactReport): string {
  const lines = [`Change: ${report.summary}`, `Impact: ${report.impact}`, '', 'QA checks:', ...report.qaChecks.map(check => `- ${check}`)];

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
          content: `Generate a concise plain-English QA change-impact report using only this evidence. Preserve precise quantities and do not infer user-facing surfaces:\n\n${serializedEvidence}`,
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
                maxLength: 240,
                description: 'Exactly one short sentence describing the actual behavior change supported by the evidence, in plain English with precise quantities. No headings, field labels, Markdown, or report titles.',
              },
              impact: {
                type: 'string',
                maxLength: 240,
                description: 'Exactly one short sentence describing the most important supported QA-visible consequence. Do not invent consequences or user-facing surfaces. No headings, field labels, or Markdown.',
              },
              qaChecks: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'string',
                  maxLength: 200,
                  description: 'Start with Verify, Check, Confirm, Validate, Test, or Ensure. Describe an actionable check of the specific changed behavior using only supplied evidence/context; no generic recommendations. Plain text only, no headings, field labels, or Markdown.',
                },
              },
              uncertainty: {
                type: 'array',
                maxItems: 2,
                items: {
                  type: 'string',
                  maxLength: 200,
                  description: 'A genuine uncertainty or missing fact in the evidence, in simple non-technical plain text. Do not invent risks or add generic disclaimers; use an empty array when nothing is uncertain. No headings, field labels, or Markdown.',
                },
              },
            },
            required: ['summary', 'impact', 'qaChecks', 'uncertainty'],
            additionalProperties: false,
          },
        },
      },
    };

    for (; attempt <= 2; attempt += 1) {
      const { data: completion, request_id: requestId } = await client.chat.completions
        .create(
          request,
          {
            headers: {
              'X-Client-Request-Id': traceId,
            },
          },
        )
        .withResponse();

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
            content: `Correct the previous report using only the same evidence above. Return the complete JSON object matching the schema. Fix these validation errors:\n${errors.join('\n')}\nUse exactly one short actual behavior sentence for summary and one supported QA consequence sentence for impact. All fields must be nonempty plain text without headings, field labels, Markdown, or line breaks. Start every QA check with Verify, Check, Confirm, Validate, Test, or Ensure and describe a specific action. Include only genuine uncertainties; otherwise use an empty uncertainty array.`,
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
