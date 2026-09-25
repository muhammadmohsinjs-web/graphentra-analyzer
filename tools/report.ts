#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from 'dotenv';
import {
  ANALYZER_VERSION, analyzeRepository, computeDeterministicEvidenceIdentity,
  parseCliOptions, resolveCliComparison, writeEvidenceFile, writeJsonArtifact, writeMarkdownReport,
} from '@graphentra/analyzer';
import {
  buildLegacyAnalysisResult, generateQAReport, getOrCreateApplicationContext,
  DEFAULT_OPENROUTER_MODEL, type LLMClientOptions,
} from '@graphentra/reporting';

const loaderFrames = ['✦', '✧', '✦', '✧'];
const loaderColors = ['\u001b[38;5;213m', '\u001b[38;5;177m', '\u001b[38;5;141m', '\u001b[38;5;105m'];
const resetColor = '\u001b[0m';
const clearLine = '\u001b[2K';

async function withLLMLoader<T>(label: string, model: string, operation: () => Promise<T>): Promise<T> {
  const interactive = Boolean(process.stderr.isTTY);
  const color = interactive && !process.env.NO_COLOR;
  let frame = 0;
  const startedAt = Date.now();
  const render = () => {
    const symbol = loaderFrames[frame % loaderFrames.length];
    const tint = color ? loaderColors[frame % loaderColors.length] : '';
    const reset = color ? resetColor : '';
    process.stderr.write(`\r${clearLine}${tint}${symbol}${reset} LLM triggered · ${label} · ${model}…`);
    frame += 1;
  };

  if (interactive) {
    render();
  } else {
    process.stderr.write(`LLM triggered · ${label} · ${model}\n`);
  }
  const timer = interactive ? setInterval(render, 120) : undefined;

  try {
    const result = await operation();
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
    console.log('Graphentra Local QA Reporting\nUsage: npm run report -- --target <dir> [--base <ref> --head <ref> | --working-tree] [--output <evidence-file>] [--report <QA-Markdown-file>] [--generate-context]\n--generate-context explicitly sends eligible source to the configured provider.');
    return;
  }
  if (options.version) { console.log(ANALYZER_VERSION); return; }
  if (dependencies.loadEnvironment !== false) config({ path: ['.env'], quiet: true });
  const environment = dependencies.environment ?? process.env;
  let comparison;
  try { comparison = resolveCliComparison(options, environment); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Invalid comparison.'); process.exitCode = 2; return; }
  try {
    const target = fs.realpathSync(path.resolve(options.target));
    const directory = path.join(target, '.graphentra');
    const evidencePath = path.resolve(options.output ?? path.join(directory, 'evidence.json'));
    const contextPath = path.join(directory, 'application-context.json');
    const reportPath = options.report ? path.resolve(options.report) : undefined;
    const destinations = [evidencePath, contextPath, path.join(directory, 'technical-graph.json'), path.join(directory, 'analysis.json'), ...(reportPath ? [reportPath] : [])];
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
    console.log(`Deterministic evidence created: ${evidencePath}`);
    const identity = computeDeterministicEvidenceIdentity(result.evidence);
    if (result.outcome !== 'completed') {
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
    const generateContext = !fs.existsSync(contextPath) && options.generateContext;
    if (!fs.existsSync(contextPath) && options.generateContext) {
      console.log('Generating application context sends all eligible TypeScript source to the configured provider.');
      sourceFiles = result.technicalGraph.analyzedFiles.map(file => ({ path: file, content: fs.readFileSync(path.join(target, file), 'utf8') }));
      const current = analyzeRepository({ target, comparison });
      if (current.evidence.sourceState.contentIdentity !== result.evidence.sourceState.contentIdentity) throw new Error('Source changed before context generation.');
    }
    const contextRequest = () => getOrCreateApplicationContext({ contextDirectory: directory, technicalGraph: result.technicalGraph,
      sourceFiles, generateContext: options.generateContext, llmOptions });
    const context = generateContext
      ? await withLLMLoader('application context', llmOptions.model ?? DEFAULT_OPENROUTER_MODEL, contextRequest)
      : await contextRequest();
    const report = await withLLMLoader('QA impact report', llmOptions.model ?? DEFAULT_OPENROUTER_MODEL,
      () => generateQAReport(result.evidence, context, llmOptions));
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
