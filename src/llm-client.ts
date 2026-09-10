import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import OpenAI, { APIError, type ClientOptions } from 'openai';
import { z } from 'zod';

config({ path: ['.env', '../.env'], quiet: true });

export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5.6-luna';

const impactReportSchema = z
  .object({
    summary: z.string().max(240),
    impact: z.string().max(240),
    qaChecks: z.array(z.string().max(200)).min(1).max(5),
    uncertainty: z.array(z.string().max(200)).max(2),
  })
  .strict();

export type ImpactReport = z.infer<typeof impactReportSchema>;

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

  logLLMTrace('request.started', {
    traceId,
    provider: 'openrouter',
    model: OPENROUTER_MODEL,
    evidenceBytes: Buffer.byteLength(serializedEvidence),
  });

  try {
    const { data: completion, request_id: requestId } = await createOpenRouterClient()
      .chat.completions.create(
        {
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: 'system',
              content: instruction,
            },
            {
              role: 'user',
              content: `Generate a QA change-impact report from this evidence in very simple, non-technical plain English that anyone without a programming background can understand:\n\n${serializedEvidence}`,
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
                    description: 'One short sentence in very simple, plain everyday words describing what changed. Avoid all programming jargon, function names, and technical terms.',
                  },
                  impact: {
                    type: 'string',
                    maxLength: 240,
                    description: 'One short sentence in very simple, non-technical language describing the most important impact on users or business workflows.',
                  },
                  qaChecks: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 5,
                    items: {
                      type: 'string',
                      maxLength: 200,
                      description: 'A plain, simple verification step that a manual tester can test without reading code.',
                    },
                  },
                  uncertainty: {
                    type: 'array',
                    maxItems: 2,
                    items: {
                      type: 'string',
                      maxLength: 200,
                      description: 'A simple non-technical explanation of any unknown or risk.',
                    },
                  },
                },
                required: ['summary', 'impact', 'qaChecks', 'uncertainty'],
                additionalProperties: false,
              },
            },
          },
        },
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

    logLLMTrace('request.completed', {
      traceId,
      requestId,
      completionId: completion.id,
      provider: 'openrouter',
      model: completion.model,
      durationMs: Date.now() - startedAt,
      finishReason: completion.choices[0]?.finish_reason,
      usage: completion.usage,
    });

    return validatedReport;
  } catch (error) {
    logLLMTrace('request.failed', {
      traceId,
      provider: 'openrouter',
      model: OPENROUTER_MODEL,
      durationMs: Date.now() - startedAt,
      ...describeError(error),
    });

    throw error;
  }
}
