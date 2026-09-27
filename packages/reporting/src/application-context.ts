import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ApplicationMap, BusinessSignals, TechnicalGraph } from '@graphentra/analyzer';
import type { ApplicationContext } from './contracts';
import {
  loadApplicationContext, type AnyApplicationContext, type ApplicationContextV2, type LoadedApplicationContext,
} from './context-contract';
import {
  generateApplicationContextV2, refreshApplicationContext, type RefreshSummary,
} from './context-generator';
import type { LLMClientOptions } from './llm-client';

export const APPLICATION_CONTEXT_FILE = 'application-context.json';
export const APPLICATION_CONTEXT_BACKUP_FILE = 'application-context.previous.json';

/**
 * Generates a v2 application context from repository evidence (see context-generator.ts).
 * Kept with the historical signature; pass the application map and signals for best results.
 */
export async function generateApplicationContext(
  technicalGraph: TechnicalGraph,
  sourceFiles: Array<{ path: string; content: string }>,
  options?: LLMClientOptions,
  extras: { applicationMap?: ApplicationMap; signals?: BusinessSignals; onProgress?: (message: string) => void } = {},
): Promise<ApplicationContextV2> {
  return generateApplicationContextV2({ technicalGraph, sourceFiles, options, ...extras });
}

/** Returns annotation entity IDs that no longer exist in the graph (informational). */
export function validateApplicationContext(context: AnyApplicationContext | ApplicationContext, technicalGraph: TechnicalGraph): string[] {
  const validIds = new Set(technicalGraph.entities.map(entity => entity.id));
  return context.entityAnnotations.map(annotation => annotation.entityId).filter(id => !validIds.has(id));
}

/** Parses v1/v2 context and reconciles stale references with the current graph. */
export function assertApplicationContext(value: unknown, graph: TechnicalGraph): ApplicationContextV2 {
  return loadApplicationContext(value, graph).context;
}

function writeContextAtomically(contextDirectory: string, context: ApplicationContextV2, options: { replace: boolean }): 'written' | 'exists' {
  fs.mkdirSync(contextDirectory, { recursive: true });
  const contextPath = path.join(contextDirectory, APPLICATION_CONTEXT_FILE);
  const temporary = path.join(contextDirectory, `.context.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(context, null, 2), { flag: 'wx', mode: 0o600 });
    if (options.replace) {
      if (fs.existsSync(contextPath)) fs.copyFileSync(contextPath, path.join(contextDirectory, APPLICATION_CONTEXT_BACKUP_FILE));
      fs.renameSync(temporary, contextPath);
    } else {
      fs.linkSync(temporary, contextPath);
    }
    return 'written';
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    return 'exists';
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export interface ContextLifecycleOptions {
  contextDirectory: string;
  technicalGraph: TechnicalGraph;
  sourceFiles?: Array<{ path: string; content: string }>;
  generateContext?: boolean;
  /** Incrementally update an existing context (new/changed functions and surfaces only). */
  refreshContext?: boolean;
  llmOptions?: LLMClientOptions;
  applicationMap?: ApplicationMap;
  signals?: BusinessSignals;
  onProgress?: (message: string) => void;
}

export interface ContextLifecycleResult extends LoadedApplicationContext {
  action: 'loaded' | 'generated' | 'refreshed';
  refreshSummary?: RefreshSummary;
}

export async function loadOrCreateApplicationContext(options: ContextLifecycleOptions): Promise<ContextLifecycleResult> {
  const { contextDirectory, technicalGraph, sourceFiles, llmOptions } = options;
  const contextPath = path.join(contextDirectory, APPLICATION_CONTEXT_FILE);
  const generatorInput = () => ({
    technicalGraph, sourceFiles: sourceFiles ?? [], options: llmOptions,
    applicationMap: options.applicationMap, signals: options.signals, onProgress: options.onProgress,
  });

  if (fs.existsSync(contextPath)) {
    const loaded = loadApplicationContext(JSON.parse(fs.readFileSync(contextPath, 'utf8')), technicalGraph);
    if (!options.refreshContext) return { ...loaded, action: 'loaded' };
    if (!sourceFiles?.length) throw new Error('Refreshing application context requires the current source files.');
    if (loaded.context.meta.migratedFrom === '1.0') {
      // A v1 context cannot be refreshed incrementally; regenerate and keep the old file as a backup.
      const context = await generateApplicationContextV2(generatorInput());
      writeContextAtomically(contextDirectory, context, { replace: true });
      return { context, warnings: ['Schema 1.0 context was replaced by a regenerated 2.0 context; the previous file was backed up.'], action: 'generated' };
    }
    const { context, summary } = await refreshApplicationContext(loaded.context, generatorInput());
    writeContextAtomically(contextDirectory, context, { replace: true });
    return { context, warnings: loaded.warnings, action: 'refreshed', refreshSummary: summary };
  }

  if (!options.generateContext || !sourceFiles || sourceFiles.length === 0) {
    throw new Error(
      `application-context.json not found in ${contextDirectory} Use the local reporting command with --generate-context to onboard it.`,
    );
  }

  const context = await generateApplicationContextV2(generatorInput());
  if (writeContextAtomically(contextDirectory, context, { replace: false }) === 'exists') {
    // Another process onboarded concurrently; its file wins.
    return { ...loadApplicationContext(JSON.parse(fs.readFileSync(contextPath, 'utf8')), technicalGraph), action: 'loaded' };
  }
  return { context, warnings: [], action: 'generated' };
}

export async function getOrCreateApplicationContext(options: ContextLifecycleOptions): Promise<ApplicationContextV2> {
  return (await loadOrCreateApplicationContext(options)).context;
}
