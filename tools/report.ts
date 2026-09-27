#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from 'dotenv';
import {
  ANALYZER_VERSION, analyzeRepository, collectBusinessSignals, computeDeterministicEvidenceIdentity, listProjectFiles,
  parseCliOptions, resolveCliComparison, writeEvidenceFile, writeJsonArtifact, writeMarkdownReport, type BusinessSignals,
} from '@graphentra/analyzer';
import {
  APPLICATION_CONTEXT_BACKUP_FILE, APPLICATION_CONTEXT_FILE, buildLegacyAnalysisResult, generateQAReport,
  loadOrCreateApplicationContext, DEFAULT_OPENROUTER_MODEL, type LLMClientOptions,
} from '@graphentra/reporting';

const loaderFrames = ['✦', '✧', '✦', '✧'];
const loaderColors = ['\u001b[38;5;213m', '\u001b[38;5;177m', '\u001b[38;5;141m', '\u001b[38;5;105m'];
const resetColor = '\u001b[0m';
const clearLine = '\u001b[2K';

async function withLLMLoader<T>(label: string, model: string, operation: (progress: (detail: string) => void) => Promise<T>): Promise<T> {
  const interactive = Boolean(process.stderr.isTTY);
  const color = interactive && !process.env.NO_COLOR;
  let frame = 0;
  let detail = '';
  const startedAt = Date.now();
  const render = () => {
    const symbol = loaderFrames[frame % loaderFrames.length];
    const tint = color ? loaderColors[frame % loaderColors.length] : '';
    const reset = color ? resetColor : '';
    process.stderr.write(`\r${clearLine}${tint}${symbol}${reset} LLM triggered · ${label}${detail ? ` · ${detail}` : ''} · ${model}…`);
    frame += 1;
  };
  const progress = (next: string) => {
    detail = next;
    if (!interactive) process.stderr.write(`LLM progress · ${label} · ${next}\n`);
  };

  if (interactive) {
    render();
  } else {
    process.stderr.write(`LLM triggered · ${label} · ${model}\n`);
  }
  const timer = interactive ? setInterval(render, 120) : undefined;

  try {
    const result = await operation(progress);
    if (timer) clearInterval(timer);
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (interactive) {
      const tint = color ? '\u001b[38;5;114m' : '';
      const reset = color ? resetColor : '';
      process.stderr.write(`\r${clearLine}${tint}✓${reset} LLM completed · ${label} · ${duration}s\n`);
    } else {
      process.stderr.write(`LLM completed · ${label} · ${duration}s\n`);
    }
    return result;
  } catch (error) {
    if (timer) clearInterval(timer);
    if (interactive) {
      const tint = color ? '\u001b[38;5;203m' : '';
      const reset = color ? resetColor : '';
      process.stderr.write(`\r${clearLine}${tint}✗${reset} LLM failed · ${label}\n`);
    } else {
      process.stderr.write(`LLM failed · ${label}\n`);
    }
    throw error;
  }
}

export async function runReport(argv: string[] = process.argv.slice(2), dependencies: {
  llmOptions?: LLMClientOptions;
  environment?: NodeJS.ProcessEnv;
  loadEnvironment?: boolean;
} = {}): Promise<void> {
  let options;
  try { options = parseCliOptions(argv, { reporting: true }); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid reporting options.');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Graphentra Local QA Reporting\nUsage: npm run report -- --target <dir> [--base <ref> --head <ref> | --working-tree] [--output <evidence-file>] [--report <QA-Markdown-file>] [--generate-context | --refresh-context]\n--generate-context onboards the repository once: it sends eligible source, documentation excerpts, and derived signals to the configured provider in bounded batches and writes .graphentra/application-context.json.\n--refresh-context re-describes only new or changed functions and new surfaces in an existing context (the previous file is kept as application-context.previous.json).');
    return;
  }
  if (options.version) { console.log(ANALYZER_VERSION); return; }
  if (options.generateContext && options.refreshContext) {
    console.error('Use either --generate-context or --refresh-context, not both.');
    process.exitCode = 2;
    return;
  }
  if (dependencies.loadEnvironment !== false) config({ path: ['.env'], quiet: true });
  const environment = dependencies.environment ?? process.env;
  let comparison;
  try { comparison = resolveCliComparison(options, environment); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Invalid comparison.'); process.exitCode = 2; return; }
  try {
    const target = fs.realpathSync(path.resolve(options.target));
    const directory = path.join(target, '.graphentra');
    const evidencePath = path.resolve(options.output ?? path.join(directory, 'evidence.json'));
    const contextPath = path.join(directory, APPLICATION_CONTEXT_FILE);
    const contextBackupPath = path.join(directory, APPLICATION_CONTEXT_BACKUP_FILE);
    const mapPath = path.join(directory, 'application-map.json');
    const reportPath = options.report ? path.resolve(options.report) : undefined;
    const destinations = [evidencePath, contextPath, contextBackupPath, mapPath, path.join(directory, 'technical-graph.json'), path.join(directory, 'analysis.json'), ...(reportPath ? [reportPath] : [])];
    const canonical = (file: string): string => fs.existsSync(file) ? fs.realpathSync(file)
      : path.dirname(file) === file ? file : path.join(canonical(path.dirname(file)), path.basename(file));
    if (new Set(destinations.map(canonical)).size !== destinations.length) throw new Error('Reporting output paths collide.');
    const result = analyzeRepository({ target, comparison });
    if (destinations.filter(file => file !== contextPath).some(destination =>
      [...result.technicalGraph.analyzedFiles, 'tsconfig.json', 'package.json'].some(file => canonical(path.join(target, file)) === canonical(destination)))) {
      throw new Error('Reporting output collides with analyzed input.');
    }
    writeEvidenceFile(evidencePath, result.evidence);
    writeJsonArtifact(directory, 'technical-graph.json', result.technicalGraph);
    writeJsonArtifact(directory, 'application-map.json', result.applicationMap);
    console.log(`Deterministic evidence created: ${evidencePath}`);
    const { surfaces, navigation, e2eFlows } = result.applicationMap;
    console.log(`Application map: ${surfaces.filter(item => item.kind === 'ui_route').length} UI routes, ${surfaces.filter(item => item.kind === 'api_endpoint').length} API endpoints, ${navigation.length} navigation links, ${e2eFlows.length} end-to-end flows.`);
    const identity = computeDeterministicEvidenceIdentity(result.evidence);
    const contextExists = fs.existsSync(contextPath);
    const wantsContextWork = (!contextExists && options.generateContext) || (contextExists && options.refreshContext);
    if (options.refreshContext && !contextExists) throw new Error('No application context to refresh. Use --generate-context to onboard first.');
    if (result.outcome !== 'completed' && !wantsContextWork) {
      if (reportPath) writeMarkdownReport(reportPath, `# Graphentra QA Report\n\nEvidence Identity: ${identity}\n\n${result.summaryMessage}`);
      console.log(result.summaryMessage);
      return;
    }
    const llmOptions = dependencies.llmOptions ?? {
      apiKey: environment.OPENROUTER_API_KEY,
      model: environment.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
      logLevel: 'off' as const,
    };
    // Existing context is validated before any whole-source read.
    let sourceFiles: Array<{ path: string; content: string }> | undefined;
    let signals: BusinessSignals | undefined;
    if (wantsContextWork) {
      console.log(options.refreshContext
        ? 'Refreshing application context sends new or changed TypeScript functions to the configured provider.'
        : 'Generating application context sends eligible TypeScript source, documentation excerpts, and derived repository signals to the configured provider in bounded batches.');
      sourceFiles = result.technicalGraph.analyzedFiles.map(file => ({ path: file, content: fs.readFileSync(path.join(target, file), 'utf8') }));
      signals = collectBusinessSignals({ projectRoot: target, files: listProjectFiles({ target, comparison }), technicalGraph: result.technicalGraph });
      const current = analyzeRepository({ target, comparison });
      if (current.evidence.sourceState.contentIdentity !== result.evidence.sourceState.contentIdentity) throw new Error('Source changed before context generation.');
    }
    const model = llmOptions.model ?? DEFAULT_OPENROUTER_MODEL;
    const contextRequest = (progress?: (detail: string) => void) => loadOrCreateApplicationContext({
      contextDirectory: directory, technicalGraph: result.technicalGraph, sourceFiles, signals,
      applicationMap: result.applicationMap, generateContext: options.generateContext, refreshContext: options.refreshContext,
      llmOptions, onProgress: progress,
    });
    const lifecycle = wantsContextWork
      ? await withLLMLoader(options.refreshContext ? 'refresh application context' : 'application context', model, contextRequest)
      : await contextRequest();
    if (lifecycle.action !== 'loaded') {
      const { coverage } = lifecycle.context.meta;
      console.log(`Application context ${lifecycle.action}: ${coverage.annotatedEntities}/${coverage.eligibleEntities} functions described, ${coverage.describedSurfaces}/${coverage.surfaces} surfaces described, ${lifecycle.context.features.length} features, ${lifecycle.context.rules.length} rules.`);
      if (lifecycle.refreshSummary) console.log(`Refresh: ${lifecycle.refreshSummary.reannotatedEntities} functions re-described, ${lifecycle.refreshSummary.addedSurfaces} surfaces added, ${lifecycle.refreshSummary.removedSurfaces} removed, ${lifecycle.refreshSummary.preservedReviewed} reviewed annotations preserved.`);
    }
    for (const warning of lifecycle.warnings) console.warn(`Context note: ${warning}`);
    if (result.outcome !== 'completed') {
      if (reportPath) writeMarkdownReport(reportPath, `# Graphentra QA Report\n\nEvidence Identity: ${identity}\n\n${result.summaryMessage}`);
      console.log(result.summaryMessage);
      return;
    }
    const report = await withLLMLoader('QA impact report', model,
      () => generateQAReport(result.evidence, lifecycle.context, llmOptions, { applicationMap: result.applicationMap }));
    const legacy = buildLegacyAnalysisResult({ headSha: result.evidence.sourceState.checkoutSha,
      evidenceIdentity: report.evidenceIdentity, changedFiles: result.changedFiles,
      changedEntities: result.changedEntities, impacts: result.impacts, qaReport: report.qaReport });
    writeJsonArtifact(directory, 'analysis.json', legacy);
    if (reportPath) writeMarkdownReport(reportPath, report.markdownReport);
    console.log(`QA report created for evidence ${report.evidenceIdentity}`);
  } catch (error) {
    console.error(`Graphentra reporting failed: ${error instanceof Error ? error.message : 'Operational failure.'}`);
    process.exitCode = 1;
  }
}
if (require.main === module) void runReport().catch(() => { console.error('Graphentra reporting failed.'); process.exitCode = 1; });
