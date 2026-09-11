import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import OpenAI from 'openai';
import { config } from 'dotenv';
import { z } from 'zod';

import { formatImpactReport, generateImpactReport, OPENROUTER_MODEL, withTransportRetries, type ImpactReport } from './llm-client';
import { extractEntityChange, getFunctionRanges, parseGitDiff as parseDiff, type ChangedFile, type EntityChange } from './change-evidence';
import { buildLLMPayload, qaInstruction } from './qa-evidence';
import { parseCliOptions, type CliOptions } from './cli';

config({
  path: ['.env', '../.env'],
  quiet: true,
});

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const ANALYZER_VERSION = '0.4.0';

const MAX_BLAST_DEPTH = 6;

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.graphentra']);

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * ============================================================
 * TECHNICAL TYPES
 * ============================================================
 */

export interface Entity {
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

interface ChangedEntity {
  entity: Entity;

  change: EntityChange;
}

interface ImpactPath {
  target: Entity;

  depth: number;

  path: Entity[];
}

export interface EntityImpact {
  changedEntity: Entity;

  change: EntityChange;

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

export interface ApplicationContext {
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

/**
 * ============================================================
 * FINAL ANALYSIS RESULT
 * ============================================================
 */

interface AnalysisResult {
  schemaVersion: '1.1';

  repository: {
    headSha: string;
  };

  changedFiles: ChangedFile[];

  changedEntities: ChangedEntity[];

  impacts: EntityImpact[];

  qaReport: ImpactReport;

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

let cliOptions: CliOptions;

try {
  cliOptions = parseCliOptions(process.argv.slice(2));
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  console.error('Usage: graphentra --target <repository-path> [--base <ref> --head <ref>] [--report <file>]\n');
  process.exit(1);
}

const projectRoot = path.resolve(cliOptions.target);
const reportPath = cliOptions.report ? path.resolve(cliOptions.report) : undefined;
const analyzerRoot = path.resolve(__dirname, '..');

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
      if (projectRoot !== analyzerRoot && path.resolve(absolutePath) === analyzerRoot) {
        continue;
      }

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

  writeMarkdownReport('No TypeScript files were found in the target repository.');

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

  const completion = await withTransportRetries(() => client.chat.completions.create({
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
  }));

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

  // Persistent semantic knowledge, unlike the regenerated graph and analysis artifacts.
  // CI must restore this committed/persisted file before running the analyzer.
  if (fs.existsSync(contextPath)) {
    console.log('\n🧠 Application Context found.');

    const parsed = JSON.parse(fs.readFileSync(contextPath, 'utf8'));

    return applicationContextSchema.parse(parsed);
  }

  const context = await generateApplicationContext(technicalGraph);

  writeGraphentraJSON('application-context.json', context);

  console.log(`✅ Application Context generated: ${contextPath}`);

  console.warn('\n⚠️ If this was generated inside GitHub Actions, the file is temporary.');

  console.warn('Persist .graphentra/application-context.json in the analyzed repository (commit it or restore it before CI runs).');
  console.warn('technical-graph.json and analysis.json are disposable run artifacts, not persistent application context.\n');

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
  const base = cliOptions.base ?? process.env.BASE_SHA?.trim();

  const head = cliOptions.head ?? process.env.HEAD_SHA?.trim();

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
    ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-color', '--unified=3', base, head, '--', target],

    gitRepositoryRoot,
  );
}

/**
 * ============================================================
 * PARSE GIT DIFF
 * ============================================================
 */

function parseGitDiff(diff: string): ChangedFile[] {
  return parseDiff(diff, gitPathToProjectPath).filter(change => isTypeScriptFile(change.file));
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
    if (matchingEntities.length === 0) continue;

    const previousRanges = change.oldFile
      ? getFunctionRanges(change.oldFile, executeGit([
          'show', `${getDiffRange().base}:${path.posix.join(projectInsideRepository, change.oldFile)}`,
        ], gitRepositoryRoot))
      : [];

    for (const entity of matchingEntities) {
      const candidates = previousRanges.filter(previous => previous.name === entity.name);
      // Ambiguous old identities must not leak another function's removed code.
      const previous = candidates.length === 1 ? candidates[0] : undefined;
      const overlaps = (a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }) =>
        a.startLine <= b.endLine && b.startLine <= a.endLine;
      if (matchingEntities.some(other => other !== entity && overlaps(entity, other)) ||
          (previous && previousRanges.some(other => other !== previous && overlaps(previous, other)))) {
        console.warn(`Skipping ambiguous overlapping function ranges: ${entity.id}`);
        continue;
      }
      const entityChange = extractEntityChange(change, entity, previous);

      if (entityChange) {
        result.push({
          entity,

          change: entityChange,
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

function writeMarkdownReport(content: string): void {
  if (!reportPath) {
    return;
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${content.trim()}\n`, 'utf8');
  console.log(`\n📋 Markdown report: ${reportPath}`);
}

function formatMarkdownReport(report: ImpactReport): string {
  return `# Graphentra QA Impact Report\n\n${formatImpactReport(report)}`;
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
   * 2. GET GIT CHANGE
   * ==========================================================
   */

  const gitDiff = getGitDiff();

  if (!gitDiff.trim()) {
    console.log('\nNo Git changes found.');

    const { base, head } = getDiffRange();
    writeMarkdownReport(`No TypeScript changes were found between \`${base}\` and \`${head}\`.`);

    return;
  }

  const changedFiles = parseGitDiff(gitDiff);

  console.log(`\n📝 Changed TypeScript files: ${changedFiles.length}`);

  for (const change of changedFiles) {
    printChangedFile(change);
  }

  /**
   * ==========================================================
   * 3. MAP CHANGED LINES TO FUNCTIONS
   * ==========================================================
   */

  const changedEntities = findChangedEntities(changedFiles);

  console.log(`\n🎯 Changed functions: ${changedEntities.length}`);

  for (const changed of changedEntities) {
    console.log(`  → ${changed.entity.id}`);
  }

  if (changedEntities.length === 0) {
    console.log('\nNo supported standalone function matched the changed lines.');

    writeMarkdownReport('No supported standalone TypeScript function declarations matched the changed lines.');

    return;
  }

  /**
   * ==========================================================
   * 4. LOAD OR GENERATE APPLICATION CONTEXT
   * ==========================================================
   */

  const applicationContext = await getOrCreateApplicationContext(technicalGraph);

  validateApplicationContext(applicationContext);

  /**
   * ==========================================================
   * 5. BUILD DETERMINISTIC IMPACT
   * ==========================================================
   */

  const impacts = changedEntities.map(buildImpact);

  console.log(`\n💥 Deterministic impact evidence built for ${impacts.length} changed functions.`);

  /**
   * ==========================================================
   * 6. LLM QA REPORT
   * ==========================================================
   */

  const payload = buildLLMPayload(impacts, applicationContext);

  console.log('\n🤖 Sending unified deterministic evidence + relevant application context to LLM...');

  const report = await generateImpactReport({
    instruction: qaInstruction,

    evidence: payload,
  });

  console.log('\n========================================');

  console.log('🤖 UNIFIED QA IMPACT REPORT');

  console.log('========================================\n');

  console.log(formatImpactReport(report));

  /**
   * ==========================================================
   * 7. SAVE FINAL ANALYSIS
   * ==========================================================
   */

  const result: AnalysisResult = {
    schemaVersion: '1.1',

    repository: {
      headSha: getHeadSha(),
    },

    changedFiles,

    changedEntities,

    impacts,

    qaReport: report,

    limitations: [
      'Only TypeScript is analyzed.',

      'Only named standalone function declarations are supported.',

      'Only CALLS relationships are currently supported.',

      'Class methods are not analyzed.',

      'Arrow functions are not analyzed.',

      'Dynamic calls are not analyzed.',

      'Deleted functions have no current graph entity; renamed or ambiguous functions may lack removed-code evidence.',

      'Overlapping function line ranges are skipped rather than sharing ambiguous evidence.',

      'Application surfaces are not yet discovered.',

      'Blast radius is limited to depth 6.',
    ],
  };

  const analysisPath = writeGraphentraJSON('analysis.json', result);

  writeMarkdownReport(formatMarkdownReport(report));

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
