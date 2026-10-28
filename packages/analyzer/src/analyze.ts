import {
  ANALYZER_VERSION,
  DEFAULT_ENGINE,
  ENGINE_PROFILES,
  EVIDENCE_ARTIFACT_KIND,
  MAX_AFFECTED_ENTITIES,
  EVIDENCE_SCHEMA_VERSION,
  EXTENDED_EVIDENCE_SCHEMA_VERSION,
  type AnalyzeOptions,
  type AnalyzeResult,
  type DiagnosticItem,
  type EngineProfile,
  type DeterministicEvidence,
} from './contracts';
import { GraphentraError } from './errors';
import { parseGitDiff } from './change-evidence';
import { computeAttribution } from './attribution';
import { buildImpact, findChangedEntities } from './impact';
import { DEFAULT_LIMITATIONS, EXTENDED_LIMITATIONS } from './output';
import { createBaselineSnapshot } from './baseline-host';
import { captureSourceSnapshot } from './source-snapshot';
import { createRepositoryContext, type RepositoryContext } from './repository';
import { extractTechnicalGraph, isAnalyzableFile, type ExtractedGraph } from './technical-graph';
import { APPLICATION_MAP_SCHEMA_VERSION, extractApplicationMap, type ApplicationMap } from './application-map';
import { buildToolchainRecord, toolchainDiagnostics } from './toolchain';
import { assertValidEvidenceEnvelope } from './validator';
import type { CompilerOptions } from 'typescript';

export function analyzeRepository(options: AnalyzeOptions): AnalyzeResult {
  if (options.engine !== undefined && !ENGINE_PROFILES.includes(options.engine)) {
    throw new GraphentraError(`Unknown engine "${String(options.engine)}". Expected one of: ${ENGINE_PROFILES.join(', ')}.`, 'INVALID_OPTIONS');
  }
  const maxAffected = options.maxAffectedEntities ?? MAX_AFFECTED_ENTITIES;
  if (!Number.isSafeInteger(maxAffected) || maxAffected < 1) {
    throw new GraphentraError(`maxAffectedEntities must be a positive integer, got ${String(options.maxAffectedEntities)}.`, 'INVALID_OPTIONS');
  }
  const engine = options.engine ?? DEFAULT_ENGINE;
  const repo =createRepositoryContext(options.target, options.comparison, {
    gitTimeoutMs: options.gitTimeoutMs,
    excludePaths: options.excludePaths,
    engine,
  });

  const targetPath = repo.projectInsideRepository;
  const headSha = repo.comparison.resolvedHeadSha ?? repo.sourceState.checkoutSha;

  const snapshot = captureSourceSnapshot(repo, engine);
  const extracted = extractTechnicalGraph({
    files: snapshot.files,
    compilerOptions: snapshot.compilerOptions,
    host: snapshot.host,
    projectRoot: repo.projectRoot,
    headSha,
    targetPath,
    excludePaths: options.excludePaths,
    engine,
  });
  // Extended engine: stamp language once, so graph, changed entities and impacts share the same objects.
  if (engine === 'extended') for (const entity of extracted.entities) entity.language ??= 'typescript';

  const diagnostics: DiagnosticItem[] = [...toolchainDiagnostics()];
  if (engine === 'extended') diagnostics.push(...extracted.diagnostics);
  let gitDiff = snapshot.gitDiff;
  if (repo.comparison.mode === 'working-tree') {
    for (const file of repo.listFiles(true).filter(file => isAnalyzableFile(file, engine))) {
      const content = snapshot.readFile(`${repo.projectRoot}/${file}`);
      if (content === undefined) continue;
      const lines = content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (!content) continue;
      const repoFile = repo.projectInsideRepository === '.' ? file : `${repo.projectInsideRepository}/${file}`;
      gitDiff += `\ndiff --git ${JSON.stringify(`a/${repoFile}`)} ${JSON.stringify(`b/${repoFile}`)}\n` +
        `--- /dev/null\n+++ ${JSON.stringify(`b/${repoFile}`)}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map(line => `+${line}`).join('\n') + '\n';
    }
  }
  const changedFiles = parseGitDiff(gitDiff, repo.gitPathToProjectPath)
    .filter(change => repo.includesPath(change.file));
  const supportedChanges = changedFiles.filter(change => isAnalyzableFile(change.file, engine));
  // Base graph (P3-1): internal until the evidence schema carries it; D11 skips it when nothing analyzable changed.
  const baseGraph = engine === 'extended' && supportedChanges.length > 0
    ? extractBaseGraph(repo, engine, { headCompilerOptions: snapshot.compilerOptions })
    : undefined;
  void baseGraph;
  if (changedFiles.some(change => !isAnalyzableFile(change.file, engine))) {
    diagnostics.push({ code: 'OUTSIDE_SUPPORTED_SCOPE', severity: 'warning',
      message: 'Changes outside TypeScript extraction scope were not analyzed for function impact.' });
  }
  const { changedEntities, diagnostics: entityWarnings, extraDiagnostics } = findChangedEntities({
    changedFiles: supportedChanges,
    entities: extracted.entities,
    parentById: extracted.parentById,
    getBaselineSource: oldFile => repo.getBaselineSource(oldFile, repo.comparison.resolvedBaseSha),
  }, engine);
  for (const message of entityWarnings) diagnostics.push({ code: 'AMBIGUOUS_FUNCTION_RANGE', severity: 'warning', message });
  if (engine === 'extended') diagnostics.push(...extraDiagnostics);
  const impacts = changedEntities.map(changed => buildImpact(changed, extracted.reverseAdjacency, extracted.entityById,
    undefined, engine, maxAffected));
  for (const impact of impacts) {
    if (impact.blastRadius.truncated) {
      diagnostics.push({ code: 'BLAST_RADIUS_TRUNCATED', severity: 'info', entityId: impact.changedEntity.id,
        message: `Blast radius for ${impact.changedEntity.id} was cut at ${maxAffected} affected entities; shallowest and lowest-ID entities are kept.` });
    }
  }
  const outcome = extracted.files.length === 0 ? 'no_source_files'
    : changedFiles.length === 0 ? 'no_changes'
    : changedEntities.length === 0 ? 'no_supported_changes' : 'completed';
  if (outcome === 'no_source_files') diagnostics.push({ code: 'NO_SOURCE_FILES', severity: 'info',
    message: 'No current supported TypeScript source files are present; deletion evidence may remain.' });
  if (outcome === 'no_supported_changes') diagnostics.push({ code: 'NO_SUPPORTED_CHANGES', severity: 'warning',
    message: 'Changes did not match supported current function declarations. This is not a no-risk result.' });
  const sourcePolicy = repo.comparison.mode === 'commit' ? 'git-tracked' : 'git-tracked-and-nonignored-untracked';
  const extended = engine === 'extended';
  const attribution = extended ? computeAttribution(supportedChanges, changedEntities) : undefined;
  if (attribution && attribution.total > 0) {
    const { code, total, ratio, module, unattributed } = attribution;
    diagnostics.push({ code: 'ATTRIBUTED_LINE_RATIO', severity: 'info',
      message: `${code} of ${total} changed lines attributed to code entities (ratio ${ratio.toFixed(4)}); ${module} module-level, ${unattributed} unattributed.` });
  }
  const evidence: DeterministicEvidence = {
    artifactKind: EVIDENCE_ARTIFACT_KIND,
    schemaVersion: extended ? EXTENDED_EVIDENCE_SCHEMA_VERSION : EVIDENCE_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    target: { targetPath },
    comparison: repo.comparison,
    sourceState: { ...repo.sourceState, contentIdentity: snapshot.identity() },
    options: extended ? { excludePaths: repo.excludePaths, sourcePolicy, engine: 'extended' }
      : { excludePaths: repo.excludePaths, sourcePolicy },
    ...(extended ? { toolchain: buildToolchainRecord() } : {}),
    outcome, technicalGraph: extracted.technicalGraph, changedFiles, changedEntities, impacts,
    diagnostics, limitations: [...(extended ? EXTENDED_LIMITATIONS : DEFAULT_LIMITATIONS)],
  };
  snapshot.verify();
  assertValidEvidenceEnvelope(evidence);
  const applicationMap = buildApplicationMap(extracted, repo.projectRoot, headSha);
  const summaryMessage = outcome === 'completed' ? `Deterministic impact evidence built for ${impacts.length} changed functions.`
    : outcome === 'no_changes' ? 'No changes were found in the included target scope.'
    : outcome === 'no_source_files' ? 'No TypeScript files were found in the target repository.'
    : 'Changes did not match supported current function declarations.';
  return { outcome, technicalGraph: extracted.technicalGraph, evidence, applicationMap, changedFiles, changedEntities,
    impacts, gitDiff, diagnostics, summaryMessage, ...(attribution ? { attribution } : {}) };
}

type BaseNodeHook = NonNullable<Parameters<typeof extractTechnicalGraph>[0]['onEntityNode']>;

/** Graph of the base revision, built from Git objects through a host that never touches the head snapshot's reads. */
export function extractBaseGraph(
  repo: RepositoryContext,
  engine: EngineProfile,
  options: { headCompilerOptions: CompilerOptions; onEntityNode?: BaseNodeHook },
): { graph: ExtractedGraph; diagnostics: DiagnosticItem[] } {
  const baseSha = repo.comparison.resolvedBaseSha;
  const baseline = createBaselineSnapshot(repo, baseSha, engine, options.headCompilerOptions);
  const graph = extractTechnicalGraph({
    files: baseline.files,
    compilerOptions: baseline.compilerOptions,
    host: baseline.host,
    projectRoot: repo.projectRoot,
    headSha: baseSha,
    targetPath: repo.projectInsideRepository,
    excludePaths: repo.excludePaths,
    engine,
    onEntityNode: options.onEntityNode,
  });
  if (engine === 'extended') for (const entity of graph.entities) entity.language ??= 'typescript';
  // Release the base Program: only plain data survives extraction.
  graph.program = undefined;
  graph.checker = undefined;
  graph.symbolToEntity = undefined;
  graph.toProjectPath = undefined;
  return { graph, diagnostics: [...baseline.diagnostics, ...graph.diagnostics] };
}

function emptyApplicationMap(headSha: string, reason?: string): ApplicationMap {
  return {
    schemaVersion: APPLICATION_MAP_SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, headSha,
    platform: { frontend: false, backend: false, frameworks: [] },
    surfaces: [], navigation: [], requests: [], e2eFlows: [], relations: [], entityFingerprints: {},
    limitations: reason ? [reason] : [],
  };
}

/** The application map is best-effort: a failure never blocks deterministic evidence. */
function buildApplicationMap(extracted: ExtractedGraph, projectRoot: string, headSha: string): ApplicationMap {
  if (!extracted.program || !extracted.checker || !extracted.symbolToEntity || !extracted.toProjectPath) return emptyApplicationMap(headSha);
  try {
    return extractApplicationMap({
      program: extracted.program, checker: extracted.checker, symbolToEntity: extracted.symbolToEntity,
      entities: extracted.entities, relations: extracted.relations, files: extracted.files,
      toProjectPath: extracted.toProjectPath, projectRoot, headSha,
    });
  } catch (error) {
    return emptyApplicationMap(headSha, `Application map extraction failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** Project-relative inventory (tracked + non-ignored untracked) used for business-signal collection. */
export function listProjectFiles(options: Pick<AnalyzeOptions, 'target' | 'comparison' | 'excludePaths' | 'gitTimeoutMs'>): string[] {
  const repo = createRepositoryContext(options.target, options.comparison, {
    gitTimeoutMs: options.gitTimeoutMs, excludePaths: options.excludePaths,
  });
  return [...new Set([...repo.listFiles(), ...repo.listFiles(true)])].sort();
}
