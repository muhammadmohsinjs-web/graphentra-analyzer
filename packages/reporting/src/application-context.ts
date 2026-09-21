import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { TechnicalGraph } from '@graphentra/analyzer';
import {
  type ApplicationContext,
  applicationContextSchema,
} from './contracts';
import {
  createOpenRouterClient,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODEL,
  withTransportRetries,
  type LLMClientOptions,
} from './llm-client';

export async function generateApplicationContext(
  technicalGraph: TechnicalGraph,
  sourceFiles: Array<{ path: string; content: string }>,
  options?: LLMClientOptions,
): Promise<ApplicationContext> {
  const client = createOpenRouterClient(options);
  const targetModel =
    typeof options === 'object' && options?.model
      ? options.model
      : DEFAULT_OPENROUTER_MODEL;

  const completion = await withTransportRetries(() =>
    client.chat.completions.create({
      model: targetModel,
      messages: [
        {
          role: 'system',
          content: `
You are Graphentra's application-understanding assistant.

You receive:

1. A deterministic TypeScript technical graph.
2. The application's TypeScript source code.

The deterministic graph is authoritative for:
- entity IDs,
- functions,
- files,
- CALLS relationships.

Your job is semantic interpretation only.

Determine:
- what the application does,
- its main domains,
- important business terminology,
- the business/application meaning of technical entities,
- useful application facts.

Rules:

- Never invent technical entities.
- entityId values MUST exactly match IDs from technicalGraph.entities.
- Never invent CALLS relationships.
- Do not claim unsupported facts.
- Use "unknowns" when information is unclear.
- Keep descriptions concise.
`.trim(),
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              technicalGraph,
              sourceFiles,
            },
            null,
            2,
          ),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'graphentra_application_context',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              schemaVersion: {
                type: 'string',
                enum: ['1.0'],
              },
              application: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  summary: { type: 'string' },
                  purpose: { type: 'string' },
                },
                required: ['name', 'summary', 'purpose'],
              },
              domains: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['id', 'name', 'description'],
                },
              },
              terminology: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    term: { type: 'string' },
                    meaning: { type: 'string' },
                  },
                  required: ['term', 'meaning'],
                },
              },
              entityAnnotations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    entityId: { type: 'string' },
                    businessMeaning: { type: 'string' },
                    domainIds: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    confidence: {
                      type: 'string',
                      enum: ['high', 'medium', 'low'],
                    },
                  },
                  required: [
                    'entityId',
                    'businessMeaning',
                    'domainIds',
                    'confidence',
                  ],
                },
              },
              applicationFacts: {
                type: 'array',
                items: { type: 'string' },
              },
              unknowns: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: [
              'schemaVersion',
              'application',
              'domains',
              'terminology',
              'entityAnnotations',
              'applicationFacts',
              'unknowns',
            ],
          },
        },
      },
    }),
  );

  const content = completion.choices[0]?.message.content;
  if (!content) {
    throw new Error('Application Context LLM returned no content.');
  }

  const parsed = JSON.parse(content);
  return applicationContextSchema.parse(parsed);
}

export function validateApplicationContext(
  context: ApplicationContext,
  technicalGraph: TechnicalGraph,
): string[] {
  const validIds = new Set(technicalGraph.entities.map(entity => entity.id));
  const invalidIds = context.entityAnnotations
    .map(annotation => annotation.entityId)
    .filter(id => !validIds.has(id));

  return invalidIds;
}

export async function getOrCreateApplicationContext(options: {
  contextDirectory: string;
  technicalGraph: TechnicalGraph;
  sourceFiles?: Array<{ path: string; content: string }>;
  generateContext?: boolean;
  llmOptions?: LLMClientOptions;
}): Promise<ApplicationContext> {
  const { contextDirectory, technicalGraph, sourceFiles, llmOptions } = options;
  const contextPath = path.join(contextDirectory, 'application-context.json');

  if (fs.existsSync(contextPath)) {
    const parsed = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    return assertApplicationContext(parsed, technicalGraph);
  }

  if (!options.generateContext || !sourceFiles || sourceFiles.length === 0) {
    throw new Error(
      `application-context.json not found in ${contextDirectory} Use the local reporting command with --generate-context to onboard it.`,
    );
  }

  const clientOpts = llmOptions;
  const context = await generateApplicationContext(technicalGraph, sourceFiles, clientOpts);
  fs.mkdirSync(contextDirectory, { recursive: true });
  assertApplicationContext(context, technicalGraph);
  const temporary = path.join(contextDirectory, `.context.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(context, null, 2), { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, contextPath);
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    return assertApplicationContext(JSON.parse(fs.readFileSync(contextPath, 'utf8')), technicalGraph);
  } finally { fs.rmSync(temporary, { force: true }); }

  return context;
}

export function assertApplicationContext(value: unknown, graph: TechnicalGraph): ApplicationContext {
  const context = applicationContextSchema.parse(value);
  const domainIds = context.domains.map(domain => domain.id);
  const annotationIds = context.entityAnnotations.map(annotation => annotation.entityId);
  if (validateApplicationContext(context, graph).length || new Set(domainIds).size !== domainIds.length ||
      new Set(annotationIds).size !== annotationIds.length || context.entityAnnotations.some(annotation =>
        annotation.domainIds.some(id => !domainIds.includes(id)))) {
    throw new Error('Application context references invalid or duplicate entities/domains.');
  }
  return context;
}
