import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import OpenAI from 'openai';
import { config } from 'dotenv';
import { z } from 'zod';

import { formatImpactReport, generateImpactReport, OPENROUTER_MODEL } from './llm-client';

config({
  path: ['.env', '../.env'],
  quiet: true,
});

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const ANALYZER_VERSION = '0.3.0';

const MAX_BLAST_DEPTH = 6;

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.graphentra']);

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * ============================================================
 * TECHNICAL TYPES
 * ============================================================
 */

interface Entity {
  id: string;

  kind: 'function';

  name: string;

  file: string;

  startLine: number;

  endLine: number;
}

interface Relation {
  from: string;

  to: string;

  type: 'CALLS';
}

interface ChangedFile {
  file: string;

  changedLines: number[];

  addedCode: string[];

  removedCode: string[];

  diff: string;
}

interface ChangedEntity {
  entity: Entity;

  change: ChangedFile;
}

interface ImpactPath {
  target: Entity;

  depth: number;

  path: Entity[];
}

interface EntityImpact {
  changedEntity: Entity;

  change: ChangedFile;

  directDependents: Entity[];

  blastRadius: {
    totalAffectedEntities: number;

    entities: Entity[];

    paths: ImpactPath[];
  };

  terminalDependents: Entity[];
}

interface TechnicalGraph {
  schemaVersion: '1.0';

  repository: {
    root: string;

    headSha: string;

    generatedAt: string;

    analyzerVersion: string;
  };

  capabilities: {
    language: 'typescript';

    entityKinds: ['function'];

    relationTypes: ['CALLS'];

    maxBlastDepth: number;
  };

  analyzedFiles: string[];

  entities: Entity[];

  relations: Relation[];
}

/**
 * ============================================================
 * APPLICATION CONTEXT
 * ============================================================
 */

type Confidence = 'high' | 'medium' | 'low';

interface ApplicationContext {
  schemaVersion: '1.0';

  application: {
    name: string;

    summary: string;

    purpose: string;
  };

  domains: Array<{
    id: string;

    name: string;

    description: string;
  }>;

  terminology: Array<{
    term: string;

    meaning: string;
  }>;

  entityAnnotations: Array<{
    entityId: string;

    businessMeaning: string;

    domainIds: string[];

    confidence: Confidence;
  }>;

  applicationFacts: string[];

  unknowns: string[];
}

interface RelevantApplicationContext {
  application: ApplicationContext['application'];

  domains: ApplicationContext['domains'];

  terminology: ApplicationContext['terminology'];

  entityAnnotations: ApplicationContext['entityAnnotations'];

  applicationFacts: string[];

  unknowns: string[];

  unmappedEntityIds: string[];
}

/**
 * ============================================================
 * FINAL ANALYSIS RESULT
 * ============================================================
 */

interface QAReportResult {
  changedEntityId: string;

  report: {
    summary: string;

    impact: string;

    qaChecks: string[];

    uncertainty: string[];
  };
}

interface AnalysisResult {
  schemaVersion: '1.0';

  repository: {
    headSha: string;
  };

  changedFiles: ChangedFile[];

  changedEntities: ChangedEntity[];

  impacts: EntityImpact[];

  qaReports: QAReportResult[];

  limitations: string[];
}

/**
 * ============================================================
 * APPLICATION CONTEXT VALIDATION
 * ============================================================
 */

const applicationContextSchema = z
  .object({
    schemaVersion: z.literal('1.0'),

    application: z
      .object({
        name: z.string(),

        summary: z.string(),

        purpose: z.string(),
      })
      .strict(),

    domains: z.array(
      z
        .object({
          id: z.string(),

          name: z.string(),

          description: z.string(),
        })
        .strict(),
    ),

    terminology: z.array(
      z
        .object({
          term: z.string(),

          meaning: z.string(),
        })
        .strict(),
    ),

    entityAnnotations: z.array(
      z
        .object({
          entityId: z.string(),

          businessMeaning: z.string(),

          domainIds: z.array(z.string()),

          confidence: z.enum(['high', 'medium', 'low']),
        })
        .strict(),
    ),

    applicationFacts: z.array(z.string()),

    unknowns: z.array(z.string()),
  })
  .strict();

/**
 * ============================================================
 * CLI
 * ============================================================
 */

const targetRepository = process.argv.slice(2).find(argument => !argument.startsWith('--'));

if (!targetRepository) {
  console.error('\n❌ Repository path is required.');

  console.error('Usage: npm run analyze -- <repository-path>\n');

  process.exit(1);
}

const projectRoot = path.resolve(targetRepository);

if (!fs.existsSync(projectRoot)) {
  console.error(`\n❌ Repository does not exist: ${projectRoot}\n`);

  process.exit(1);
}

/**
 * ============================================================
 * GIT
 * ============================================================
 */

function executeGit(args: string[], cwd: string = projectRoot): string {
  return execFileSync('git', args, {
    cwd,

    encoding: 'utf8',

    maxBuffer: 20 * 1024 * 1024,
  }).trimEnd();
}

let gitRepositoryRoot: string;

try {
  gitRepositoryRoot = executeGit(['rev-parse', '--show-toplevel']);
} catch {
  console.error(`❌ Not a Git repository: ${projectRoot}`);

  process.exit(1);
}

const projectInsideRepository = path.relative(gitRepositoryRoot, projectRoot).replace(/\\/g, '/');

function getHeadSha(): string {
  return executeGit(
    ['rev-parse', 'HEAD'],

    gitRepositoryRoot,
  );
}

/**
 * ============================================================
 * FILE DISCOVERY
 * ============================================================
 */

function isTypeScriptFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.endsWith('.d.ts') || normalized.endsWith('.d.mts') || normalized.endsWith('.d.cts')) {
    return false;
  }

  return TYPESCRIPT_EXTENSIONS.has(path.extname(filePath));
}

function collectTypeScriptFiles(directory: string): string[] {
  const results: string[] = [];

  const entries = fs.readdirSync(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      results.push(...collectTypeScriptFiles(absolutePath));

      continue;
    }

    if (entry.isFile() && isTypeScriptFile(absolutePath)) {
      results.push(absolutePath);
    }
  }

  return results;
}

function normalizeProjectPath(fileName: string): string {
  return path.relative(projectRoot, fileName).replace(/\\/g, '/');
}

function gitPathToProjectPath(gitFile: string): string {
  const normalized = gitFile.replace(/\\/g, '/');

  if (projectInsideRepository && projectInsideRepository !== '.' && normalized.startsWith(`${projectInsideRepository}/`)) {
    return normalized.slice(projectInsideRepository.length + 1);
  }

  return normalized;
}

const files = collectTypeScriptFiles(projectRoot).sort();

if (files.length === 0) {
  console.log('No TypeScript files found.');

  process.exit(0);
}

/**
 * ============================================================
 * TYPESCRIPT PROGRAM
 * ============================================================
 */

function getCompilerOptions(): ts.CompilerOptions {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);

    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));

      return {
        ...parsed.options,

        noEmit: true,

        skipLibCheck: true,
      };
    }
  }

  return {
    target: ts.ScriptTarget.ES2022,

    module: ts.ModuleKind.CommonJS,

    moduleResolution: ts.ModuleResolutionKind.Node10,

    jsx: ts.JsxEmit.ReactJSX,

    noEmit: true,

    skipLibCheck: true,
  };
}

const program = ts.createProgram(files, getCompilerOptions());

const checker = program.getTypeChecker();

const analyzedFileSet = new Set(files.map(file => path.resolve(file)));

/**
 * ============================================================
 * GRAPH STORAGE
 * ============================================================
 */

const entities: Entity[] = [];

const relations: Relation[] = [];

const entityById = new Map<string, Entity>();

const symbolToEntity = new Map<ts.Symbol, Entity>();

const relationKeys = new Set<string>();

function getEntity(id: string): Entity | undefined {
  return entityById.get(id);
}

function resolveSymbol(node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);

  if (!symbol) {
    return undefined;
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  return symbol;
}

function addRelation(relation: Relation): void {
  const key = `${relation.from}|${relation.type}|${relation.to}`;

  if (relationKeys.has(key)) {
    return;
  }

  relationKeys.add(key);

  relations.push(relation);
}

/**
 * ============================================================
 * PASS 1 — FUNCTIONS
 *
 * Prototype ONLY supports:
 *
 * function foo() {}
 *
 * Not:
 * class methods
 * arrow functions
 * function expressions
 * ============================================================
 */

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) {
    continue;
  }

  if (!analyzedFileSet.has(path.resolve(sourceFile.fileName))) {
    continue;
  }

  const relativeFile = normalizeProjectPath(sourceFile.fileName);

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

      const entity: Entity = {
        id: `${relativeFile}#${node.name.text}`,

        kind: 'function',

        name: node.name.text,

        file: relativeFile,

        startLine: start.line + 1,

        endLine: end.line + 1,
      };

      entities.push(entity);

      entityById.set(entity.id, entity);

      const symbol = resolveSymbol(node.name);

      if (symbol) {
        symbolToEntity.set(symbol, entity);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * ============================================================
 * FIND CALLING FUNCTION
 * ============================================================
 */

function findEnclosingFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let current = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

/**
 * ============================================================
 * PASS 2 — CALL RELATIONSHIPS
 * ============================================================
 */

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) {
    continue;
  }

  if (!analyzedFileSet.has(path.resolve(sourceFile.fileName))) {
    continue;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calledSymbol = resolveSymbol(node.expression);

      const callerFunction = findEnclosingFunction(node);

      if (calledSymbol && callerFunction?.name) {
        const callerSymbol = resolveSymbol(callerFunction.name);

        if (callerSymbol) {
          const caller = symbolToEntity.get(callerSymbol);

          const called = symbolToEntity.get(calledSymbol);

          if (caller && called) {
            addRelation({
              from: caller.id,

              to: called.id,

              type: 'CALLS',
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * ============================================================
 * REVERSE GRAPH
 * ============================================================
 */

const reverseAdjacency = new Map<string, Relation[]>();

for (const entity of entities) {
  reverseAdjacency.set(entity.id, []);
}

for (const relation of relations) {
  reverseAdjacency.get(relation.to)?.push(relation);
}

/**
 * ============================================================
 * TECHNICAL GRAPH
 * ============================================================
 */

function buildTechnicalGraph(): TechnicalGraph {
  return {
    schemaVersion: '1.0',

    repository: {
      root: projectRoot,

      headSha: getHeadSha(),

      generatedAt: new Date().toISOString(),

      analyzerVersion: ANALYZER_VERSION,
    },

    capabilities: {
      language: 'typescript',

      entityKinds: ['function'],

      relationTypes: ['CALLS'],

      maxBlastDepth: MAX_BLAST_DEPTH,
    },

    analyzedFiles: files.map(normalizeProjectPath),

    entities: [...entities],

    relations: [...relations],
  };
}

/**
 * ============================================================
 * .GRAPHENTRA STORAGE
 * ============================================================
 */

function getGraphentraDirectory(): string {
  return path.resolve(projectRoot, '.graphentra');
}

function writeGraphentraJSON(fileName: string, value: unknown): string {
  const directory = getGraphentraDirectory();

  fs.mkdirSync(directory, {
    recursive: true,
  });

  const filePath = path.join(directory, fileName);

  fs.writeFileSync(
    filePath,

    JSON.stringify(value, null, 2),

    'utf8',
  );

  return filePath;
}

/**
 * ============================================================
 * APPLICATION CONTEXT LLM
 * ============================================================
 */

function createOpenRouterClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required.');
  }

  return new OpenAI({
    apiKey,

    baseURL: 'https://openrouter.ai/api/v1',
  });
}

async function generateApplicationContext(technicalGraph: TechnicalGraph): Promise<ApplicationContext> {
  /**
   * Prototype only.
   *
   * For a tiny demo repository we provide complete TS source.
   *
   * Do NOT do this for large production repositories later.
   */

  const sourceFiles = files.map(file => ({
    path: normalizeProjectPath(file),

    content: fs.readFileSync(file, 'utf8'),
  }));

  console.log('\n🧠 Generating first-time Application Context...');

  const client = createOpenRouterClient();

  const completion = await client.chat.completions.create({
    model: OPENROUTER_MODEL,

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
                name: {
                  type: 'string',
                },

                summary: {
                  type: 'string',
                },

                purpose: {
                  type: 'string',
                },
              },

              required: ['name', 'summary', 'purpose'],
            },

            domains: {
              type: 'array',

              items: {
                type: 'object',

                additionalProperties: false,

                properties: {
                  id: {
                    type: 'string',
                  },

                  name: {
                    type: 'string',
                  },

                  description: {
                    type: 'string',
                  },
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
                  term: {
                    type: 'string',
                  },

                  meaning: {
                    type: 'string',
                  },
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
                  entityId: {
                    type: 'string',
                  },

                  businessMeaning: {
                    type: 'string',
                  },

                  domainIds: {
                    type: 'array',

                    items: {
                      type: 'string',
                    },
                  },

                  confidence: {
                    type: 'string',

                    enum: ['high', 'medium', 'low'],
                  },
                },

                required: ['entityId', 'businessMeaning', 'domainIds', 'confidence'],
              },
            },

            applicationFacts: {
              type: 'array',

              items: {
                type: 'string',
              },
            },

            unknowns: {
              type: 'array',

              items: {
                type: 'string',
              },
            },
          },

          required: ['schemaVersion', 'application', 'domains', 'terminology', 'entityAnnotations', 'applicationFacts', 'unknowns'],
        },
      },
    },
  });

  const content = completion.choices[0]?.message.content;

  if (!content) {
    throw new Error('Application Context LLM returned no content.');
  }

  const parsed = JSON.parse(content);

  return applicationContextSchema.parse(parsed);
}

/**
 * ============================================================
 * LOAD OR CREATE APPLICATION CONTEXT
 * ============================================================
 */

async function getOrCreateApplicationContext(technicalGraph: TechnicalGraph): Promise<ApplicationContext> {
  const contextPath = path.join(getGraphentraDirectory(), 'application-context.json');

  if (fs.existsSync(contextPath)) {
    console.log('\n🧠 Application Context found.');

    const parsed = JSON.parse(fs.readFileSync(contextPath, 'utf8'));

    return applicationContextSchema.parse(parsed);
  }

  const context = await generateApplicationContext(technicalGraph);

  writeGraphentraJSON('application-context.json', context);

  console.log(`✅ Application Context generated: ${contextPath}`);

  console.warn('\n⚠️ If this was generated inside GitHub Actions, the file is temporary.');

  console.warn('For this prototype, copy/commit .graphentra/application-context.json so future runs can reuse it.\n');

  return context;
}

/**
 * ============================================================
 * VALIDATE APPLICATION CONTEXT
 * ============================================================
 */

function validateApplicationContext(context: ApplicationContext): void {
  const validIds = new Set(entities.map(entity => entity.id));

  const invalidIds = context.entityAnnotations.map(annotation => annotation.entityId).filter(id => !validIds.has(id));

  if (invalidIds.length > 0) {
    console.warn('\n⚠️ Application Context contains entity IDs not found in the current technical graph:');

    for (const id of invalidIds) {
      console.warn(`- ${id}`);
    }

    console.warn('Application Context may need regeneration.\n');
  }
}

/**
 * ============================================================
 * GIT DIFF
 * ============================================================
 */

function getDiffRange(): {
  base: string;

  head: string;
} {
  const base = process.env.BASE_SHA?.trim();

  const head = process.env.HEAD_SHA?.trim();

  if (base && head && !/^0+$/.test(base)) {
    return {
      base,
      head,
    };
  }

  return {
    base: 'HEAD~1',

    head: 'HEAD',
  };
}

function getGitDiff(): string {
  const { base, head } = getDiffRange();

  const target = projectInsideRepository && projectInsideRepository !== '.' ? projectInsideRepository : '.';

  return executeGit(
    ['diff', '--unified=3', base, head, '--', target],

    gitRepositoryRoot,
  );
}

/**
 * ============================================================
 * PARSE GIT DIFF
 * ============================================================
 */

function parseGitDiff(diff: string): ChangedFile[] {
  interface ChangeBuilder {
    changedLines: Set<number>;

    addedCode: string[];

    removedCode: string[];

    diffLines: string[];
  }

  const changedFiles = new Map<string, ChangeBuilder>();

  let currentFile: string | undefined;

  let current: ChangeBuilder | undefined;

  let newLineNumber = 0;

  let insideHunk = false;

  let oldFile: string | undefined;

  let headerLines: string[] = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = undefined;

      current = undefined;

      insideHunk = false;

      oldFile = undefined;

      headerLines = [line];

      continue;
    }

    if (!current) {
      headerLines.push(line);
    }

    if (line.startsWith('--- a/')) {
      oldFile = gitPathToProjectPath(line.slice('--- a/'.length));

      continue;
    }

    if (line.startsWith('+++ b/')) {
      currentFile = gitPathToProjectPath(line.slice('+++ b/'.length));

      current = changedFiles.get(currentFile);

      if (!current) {
        current = {
          changedLines: new Set(),

          addedCode: [],

          removedCode: [],

          diffLines: [],
        };

        changedFiles.set(currentFile, current);
      }

      current.diffLines.push(...headerLines);

      headerLines = [];

      continue;
    }

    /**
     * Deleted file.
     */

    if (line === '+++ /dev/null' && oldFile) {
      currentFile = oldFile;

      current = changedFiles.get(currentFile);

      if (!current) {
        current = {
          changedLines: new Set(),

          addedCode: [],

          removedCode: [],

          diffLines: [],
        };

        changedFiles.set(currentFile, current);
      }

      current.diffLines.push(...headerLines);

      headerLines = [];

      continue;
    }

    if (!currentFile || !current) {
      continue;
    }

    current.diffLines.push(line);

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

    if (hunk) {
      insideHunk = true;

      newLineNumber = Number(hunk[1]);

      continue;
    }

    if (!insideHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.changedLines.add(Math.max(newLineNumber, 1));

      current.addedCode.push(line.slice(1));

      newLineNumber += 1;

      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      current.changedLines.add(Math.max(newLineNumber, 1));

      current.removedCode.push(line.slice(1));

      continue;
    }

    if (line.startsWith(' ')) {
      newLineNumber += 1;
    }
  }

  return [...changedFiles.entries()]
    .map(([file, information]) => ({
      file,

      changedLines: [...information.changedLines].sort((a, b) => a - b),

      addedCode: information.addedCode,

      removedCode: information.removedCode,

      diff: information.diffLines.join('\n').trim(),
    }))
    .filter(change => isTypeScriptFile(change.file));
}

/**
 * ============================================================
 * MAP LINES → CHANGED FUNCTIONS
 * ============================================================
 */

function findChangedEntities(changedFiles: ChangedFile[]): ChangedEntity[] {
  const result: ChangedEntity[] = [];

  for (const change of changedFiles) {
    const matchingEntities = entities.filter(entity => entity.file === change.file);

    for (const entity of matchingEntities) {
      const overlaps = change.changedLines.some(line => line >= entity.startLine && line <= entity.endLine);

      if (overlaps) {
        result.push({
          entity,

          change,
        });
      }
    }
  }

  return result;
}

/**
 * ============================================================
 * GRAPH QUERIES
 * ============================================================
 */

function getCallers(entityId: string): Entity[] {
  const incoming = reverseAdjacency.get(entityId) ?? [];

  const unique = new Map<string, Entity>();

  for (const relation of incoming) {
    const caller = getEntity(relation.from);

    if (caller) {
      unique.set(caller.id, caller);
    }
  }

  return [...unique.values()];
}

/**
 * ============================================================
 * BLAST RADIUS
 * ============================================================
 */

function getBlastRadiusPaths(entityId: string): ImpactPath[] {
  const start = getEntity(entityId);

  if (!start) {
    return [];
  }

  const results: ImpactPath[] = [];

  const queue: Array<{
    entity: Entity;

    path: Entity[];

    visited: Set<string>;
  }> = [
    {
      entity: start,

      path: [start],

      visited: new Set([start.id]),
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    const depth = current.path.length - 1;

    if (depth >= MAX_BLAST_DEPTH) {
      continue;
    }

    const callers = getCallers(current.entity.id);

    for (const caller of callers) {
      if (current.visited.has(caller.id)) {
        continue;
      }

      const newPath = [...current.path, caller];

      results.push({
        target: caller,

        depth: newPath.length - 1,

        path: newPath,
      });

      const visited = new Set(current.visited);

      visited.add(caller.id);

      queue.push({
        entity: caller,

        path: newPath,

        visited,
      });
    }
  }

  return results;
}

function buildImpact(changedEntity: ChangedEntity): EntityImpact {
  const paths = getBlastRadiusPaths(changedEntity.entity.id);

  const affected = new Map<string, Entity>();

  const direct = new Map<string, Entity>();

  for (const impact of paths) {
    affected.set(impact.target.id, impact.target);

    if (impact.depth === 1) {
      direct.set(impact.target.id, impact.target);
    }
  }

  const affectedEntities = [...affected.values()];

  const terminalDependents = affectedEntities.filter(entity => getCallers(entity.id).length === 0);

  return {
    changedEntity: changedEntity.entity,

    change: changedEntity.change,

    directDependents: [...direct.values()],

    blastRadius: {
      totalAffectedEntities: affectedEntities.length,

      entities: affectedEntities,

      paths,
    },

    terminalDependents,
  };
}

/**
 * ============================================================
 * RELEVANT APPLICATION CONTEXT
 * ============================================================
 */

function selectRelevantApplicationContext(
  context: ApplicationContext,

  impact: EntityImpact,
): RelevantApplicationContext {
  const relevantIds = new Set<string>([impact.changedEntity.id, ...impact.blastRadius.entities.map(entity => entity.id)]);

  const annotations = context.entityAnnotations.filter(annotation => relevantIds.has(annotation.entityId));

  const domainIds = new Set(annotations.flatMap(annotation => annotation.domainIds));

  const domains = context.domains.filter(domain => domainIds.has(domain.id));

  const mappedIds = new Set(annotations.map(annotation => annotation.entityId));

  const unmappedEntityIds = [...relevantIds].filter(id => !mappedIds.has(id));

  return {
    application: context.application,

    domains,

    /**
     * Prototype:
     * keep terminology small enough to send all of it.
     */
    terminology: context.terminology,

    entityAnnotations: annotations,

    applicationFacts: context.applicationFacts,

    unknowns: context.unknowns,

    unmappedEntityIds,
  };
}

/**
 * ============================================================
 * QA LLM INSTRUCTION
 * ============================================================
 */

const qaInstruction = `
You are Graphentra's QA change-impact assistant.

You receive:

1. DETERMINISTIC TECHNICAL EVIDENCE
2. RELEVANT APPLICATION CONTEXT

Deterministic technical evidence is authoritative for:
- what code changed,
- which function changed,
- CALLS relationships,
- direct dependents,
- blast-radius entities,
- dependency paths.

Application Context explains semantic/business meaning.

It must never override technical evidence.

CRITICAL LANGUAGE REQUIREMENT:
You must return the QA report in VERY SIMPLE, PLAIN, NON-TECHNICAL WORDING.
Write for non-technical manual testers, product managers, and business stakeholders.
Strictly avoid programming jargon, developer terminology, and code constructs.
Do NOT use words like "function", "method", "AST", "parameters", "arguments", "returns", "callers", "call graph", "blast radius", "dependencies", "code", or technical identifiers.
Translate all technical code changes into everyday business actions, user experiences, and screen behavior.

Rules:

1. Explain the changed behavior in ONE very simple, non-technical sentence (e.g., "The system now adds an extra $2 fee to order pricing").
2. Explain the most important QA-visible impact in ONE very simple, non-technical sentence describing what users or orders will experience.
3. Recommend at most five focused, easy-to-follow QA verification checks that a manual tester can test in plain language without reading code.
4. Start each QA check with a simple everyday action verb (e.g., "Check", "Verify", "Confirm", "Test").
5. Do not invent features, pages, or workflows that are not supported by the evidence or application context.
6. Do not claim something is broken.
7. Use the supplied Git diff to understand the exact behavior change, but describe it entirely in plain non-technical language.
8. Use application context only for semantic interpretation.
9. If an impacted entity appears in unmappedEntityIds, explain any uncertainty simply without technical terms.
10. Include at most two important uncertainties, written in plain non-technical language.
11. Keep the report extremely concise, clear, and easy to understand.
`.trim();

/**
 * ============================================================
 * QA PAYLOAD
 * ============================================================
 */

function buildLLMPayload(
  impact: EntityImpact,

  context: ApplicationContext,
) {
  return {
    analysisScope: {
      language: 'typescript',

      entityGranularity: 'function',

      relationTypes: ['CALLS'],

      maxBlastDepth: MAX_BLAST_DEPTH,
    },

    changedEntity: impact.changedEntity,

    change: {
      file: impact.change.file,

      changedLines: impact.change.changedLines,

      removedCode: impact.change.removedCode,

      addedCode: impact.change.addedCode,

      diff: impact.change.diff,
    },

    directDependents: impact.directDependents,

    blastRadius: impact.blastRadius,

    terminalDependents: impact.terminalDependents,

    applicationContext: selectRelevantApplicationContext(context, impact),

    limitations: [
      'Only TypeScript is analyzed.',

      'Only named function declarations are supported.',

      'Only CALLS relationships are supported.',

      'Class methods are outside the current prototype.',

      'Arrow functions are outside the current prototype.',

      'Dynamic runtime dependencies are not resolved.',

      'Blast-radius traversal is limited to depth 6.',
    ],
  };
}

/**
 * ============================================================
 * CONSOLE HELPERS
 * ============================================================
 */

function printChangedFile(change: ChangedFile): void {
  console.log('\n----------------------------------------');

  console.log(`📄 ${change.file}`);

  console.log('----------------------------------------');

  console.log(`Changed lines: ${change.changedLines.join(', ')}`);

  if (change.removedCode.length > 0) {
    console.log('\nRemoved:');

    for (const line of change.removedCode) {
      console.log(`- ${line}`);
    }
  }

  if (change.addedCode.length > 0) {
    console.log('\nAdded:');

    for (const line of change.addedCode) {
      console.log(`+ ${line}`);
    }
  }
}

function printImpact(impact: EntityImpact): void {
  console.log('\n========================================');

  console.log(`💥 IMPACT — ${impact.changedEntity.name}`);

  console.log('========================================');

  console.log(`Entity: ${impact.changedEntity.id}`);

  console.log(`Lines: ${impact.changedEntity.startLine}-${impact.changedEntity.endLine}`);

  console.log('\nDirect dependents:');

  if (impact.directDependents.length === 0) {
    console.log('  none');
  }

  for (const entity of impact.directDependents) {
    console.log(`  → ${entity.id}`);
  }

  console.log(`\nBlast radius: ${impact.blastRadius.totalAffectedEntities}`);

  for (const pathInfo of impact.blastRadius.paths) {
    console.log(`  ${pathInfo.path.map(entity => entity.name).join(' → ')}`);
  }
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function run(): Promise<void> {
  console.log('\n========================================');

  console.log('🔍 GRAPHENTRA ANALYZER');

  console.log('========================================');

  console.log(`📁 Target: ${projectRoot}`);

  console.log(`📘 TypeScript files: ${files.length}`);

  console.log(`🔵 Functions discovered: ${entities.length}`);

  console.log(`🔗 CALLS relations: ${relations.length}`);

  /**
   * ==========================================================
   * 1. BUILD TECHNICAL GRAPH
   * ==========================================================
   */

  const technicalGraph = buildTechnicalGraph();

  const technicalGraphPath = writeGraphentraJSON('technical-graph.json', technicalGraph);

  console.log(`\n✅ Technical graph created: ${technicalGraphPath}`);

  /**
   * ==========================================================
   * 2. LOAD OR GENERATE APPLICATION CONTEXT
   * ==========================================================
   */

  const applicationContext = await getOrCreateApplicationContext(technicalGraph);

  validateApplicationContext(applicationContext);

  /**
   * ==========================================================
   * 3. GET GIT CHANGE
   * ==========================================================
   */

  const gitDiff = getGitDiff();

  if (!gitDiff.trim()) {
    console.log('\nNo Git changes found.');

    return;
  }

  const changedFiles = parseGitDiff(gitDiff);

  console.log(`\n📝 Changed TypeScript files: ${changedFiles.length}`);

  for (const change of changedFiles) {
    printChangedFile(change);
  }

  /**
   * ==========================================================
   * 4. MAP CHANGED LINES TO FUNCTIONS
   * ==========================================================
   */

  const changedEntities = findChangedEntities(changedFiles);

  console.log(`\n🎯 Changed functions: ${changedEntities.length}`);

  for (const changed of changedEntities) {
    console.log(`  → ${changed.entity.id}`);
  }

  if (changedEntities.length === 0) {
    console.log('\nNo supported standalone function matched the changed lines.');

    return;
  }

  /**
   * ==========================================================
   * 5. BUILD DETERMINISTIC IMPACT
   * ==========================================================
   */

  const impacts = changedEntities.map(buildImpact);

  const qaReports: QAReportResult[] = [];

  /**
   * ==========================================================
   * 6. LLM QA REPORT
   * ==========================================================
   */

  for (const impact of impacts) {
    printImpact(impact);

    const payload = buildLLMPayload(impact, applicationContext);

    console.log('\n🤖 Sending deterministic evidence + relevant application context to LLM...');

    const report = await generateImpactReport({
      instruction: qaInstruction,

      evidence: payload,
    });

    qaReports.push({
      changedEntityId: impact.changedEntity.id,

      report,
    });

    console.log('\n========================================');

    console.log(`🤖 QA IMPACT REPORT — ${impact.changedEntity.name}`);

    console.log('========================================\n');

    console.log(formatImpactReport(report));
  }

  /**
   * ==========================================================
   * 7. SAVE FINAL ANALYSIS
   * ==========================================================
   */

  const result: AnalysisResult = {
    schemaVersion: '1.0',

    repository: {
      headSha: getHeadSha(),
    },

    changedFiles,

    changedEntities,

    impacts,

    qaReports,

    limitations: [
      'Only TypeScript is analyzed.',

      'Only named standalone function declarations are supported.',

      'Only CALLS relationships are currently supported.',

      'Class methods are not analyzed.',

      'Arrow functions are not analyzed.',

      'Dynamic calls are not analyzed.',

      'Deleted functions require before/after AST analysis.',

      'Application surfaces are not yet discovered.',

      'Blast radius is limited to depth 6.',
    ],
  };

  const analysisPath = writeGraphentraJSON('analysis.json', result);

  console.log('\n========================================');

  console.log('✅ GRAPHENTRA ANALYSIS COMPLETE');

  console.log('========================================');

  console.log(`Technical graph: ${technicalGraphPath}`);

  console.log(`Application context: ${path.join(getGraphentraDirectory(), 'application-context.json')}`);

  console.log(`Analysis: ${analysisPath}`);

  console.log();
}

void run().catch(error => {
  console.error('\n❌ Graphentra analysis failed:');

  console.error(error);

  process.exitCode = 1;
});
