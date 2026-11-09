import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANALYZER_VERSION,
  DEFAULT_ENGINE,
  ENGINE_PROFILES,
  EVIDENCE_ARTIFACT_KIND,
  MAX_AFFECTED_ENTITIES,
  EVIDENCE_SCHEMA_VERSION,
  EXTENDED_EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION_3,
  type AnalyzeOptions,
  type AnalyzeResult,
  type DiagnosticItem,
  type Entity,
  type EntityCoordinates,
  type EntityImpact,
  type ChangedEntity,
  type EngineProfile,
  type DeterministicEvidence,
  type SkipReason as EvidenceSkipReason,
} from './contracts';
import { compareStrings } from './deterministic';
import { GraphentraError } from './errors';
import { parseGitDiff } from './change-evidence';
import { computeAttribution } from './attribution';
import { baseToHeadId } from './correspondence';
import {
  applyCorrespondence, buildDeletedImpact, buildImpact, correspondChangedFiles, entityCoordinates, findChangedEntities,
  withContractRisk,
} from './impact';
import { fingerprint, normalizeNode } from './ast-normalize';
import { classifyChange, fingerprintsOf, type EntityFingerprints } from './change-taxonomy';
import { DEFAULT_LIMITATIONS, EXTENDED_LIMITATIONS, SCHEMA_3_LIMITATIONS } from './output';
import { createBaselineSnapshot } from './baseline-host';
import { buildCoverage, mapSnapshotSkipReason } from './coverage';
import { DEFAULT_INPUT_LIMITS, inspectContent, type SkippedInput } from './input-limits';
import { nonTsChangeDiagnostics } from './non-ts-changes';
import { captureSourceSnapshot } from './source-snapshot';
import { classifyFileOrigin } from './file-origin';
import { createRepositoryContext, type RepositoryContext } from './repository';
import { extractTechnicalGraph, isAnalyzableFile, type ExtractedGraph } from './technical-graph';
import { APPLICATION_MAP_SCHEMA_VERSION, extractApplicationMapWithProvenance, type ApplicationMap, type SurfaceProvenance } from './application-map';
import { createFrameworkVersionResolver, detectFrameworkVersions, type FrameworkDetection } from './framework-version';
import { CONFIG_FILE_NAME, loadGraphentraConfig } from './config';
import { buildPhase5Evidence } from './phase5-evidence';
import { buildToolchainRecord, toolchainDiagnostics } from './toolchain';
import { assertValidEvidenceEnvelope } from './validator';
import { withChangedValueTargets } from './value-flow';
import type { CompilerOptions } from 'typescript';
import type { AdapterContext } from './adapters/types';

const EVIDENCE_SCHEMA_OPTIONS: ReadonlyArray<NonNullable<AnalyzeOptions['evidenceSchema']>> = ['2.1', '3.0'];

export function analyzeRepository(options: AnalyzeOptions): AnalyzeResult {
  if (options.engine !== undefined && !ENGINE_PROFILES.includes(options.engine)) {
    throw new GraphentraError(`Unknown engine "${String(options.engine)}". Expected one of: ${ENGINE_PROFILES.join(', ')}.`, 'INVALID_OPTIONS');
  }
  const maxAffected = options.maxAffectedEntities ?? MAX_AFFECTED_ENTITIES;
  if (!Number.isSafeInteger(maxAffected) || maxAffected < 1) {
    throw new GraphentraError(`maxAffectedEntities must be a positive integer, got ${String(options.maxAffectedEntities)}.`, 'INVALID_OPTIONS');
  }
  for (const [name, value] of [['maxDepth', options.maxDepth], ['hubThreshold', options.hubThreshold]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new GraphentraError(`${name} must be a positive integer, got ${String(value)}.`, 'INVALID_OPTIONS');
    }
  }
  if (options.evidenceSchema !== undefined && !EVIDENCE_SCHEMA_OPTIONS.includes(options.evidenceSchema)) {
    throw new GraphentraError(`Unknown evidence schema "${String(options.evidenceSchema)}". Expected one of: ${EVIDENCE_SCHEMA_OPTIONS.join(', ')}.`, 'INVALID_OPTIONS');
  }
  const engine = options.engine ?? DEFAULT_ENGINE;
  if (options.evidenceSchema === '3.0' && engine !== 'extended') {
    throw new GraphentraError('Evidence schema 3.0 requires the extended engine.', 'INVALID_OPTIONS');
  }
  // D12: graphentra.yml is read for schema 3.0 only, so 2.x output never depends on it.
  const loadedConfig = options.evidenceSchema === '3.0' ? loadGraphentraConfig(resolveTargetRoot(options.target)) : undefined;
  const config = loadedConfig?.config;
  const repo =createRepositoryContext(options.target, options.comparison, {
    gitTimeoutMs: options.gitTimeoutMs,
    excludePaths: options.excludePaths,
    engine,
    ...(config && config.ignore.length > 0 ? { excludeGlobs: config.ignore } : {}),
  });

  const targetPath = repo.projectInsideRepository;
  const headSha = repo.comparison.resolvedHeadSha ?? repo.sourceState.checkoutSha;

  const snapshot = captureSourceSnapshot(repo, engine);
  const headFingerprints = new Map<string, string>();
  const headClassFingerprints = new Map<string, EntityFingerprints>();
  const extracted = extractTechnicalGraph({
    files: snapshot.files,
    compilerOptions: snapshot.compilerOptions,
    host: snapshot.host,
    projectRoot: repo.projectRoot,
    headSha,
    targetPath,
    excludePaths: options.excludePaths,
    engine,
    onEntityNode: engine === 'extended' ? fingerprintCollector(headFingerprints, headClassFingerprints) : undefined,
  });
  // Extended engine: stamp language once, so graph, changed entities and impacts share the same objects.
  if (engine === 'extended') for (const entity of extracted.entities) entity.language ??= 'typescript';

  const diagnostics: DiagnosticItem[] = [...toolchainDiagnostics()];
  if (engine === 'extended') diagnostics.push(...extracted.diagnostics);
  if (loadedConfig) diagnostics.push(...loadedConfig.diagnostics);
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
  let supportedChanges = changedFiles.filter(change => isAnalyzableFile(change.file, engine));
  let nonSource: Array<{ file: string; origin: string }> = [];
  if (engine === 'extended' && supportedChanges.length > 0) {
    // Non-source files are reported but never traversed.
    const attributes = repo.checkAttributes(supportedChanges.map(change => change.file));
    nonSource = [];
    supportedChanges = supportedChanges.filter(change => {
      const origin = classifyFileOrigin(change.file, {
        attributes: attributes.get(change.file), content: snapshot.readFile(`${repo.projectRoot}/${change.file}`) });
      if (origin !== 'source') nonSource.push({ file: change.file, origin });
      return origin === 'source';
    });
    if (nonSource.length > 0) {
      nonSource.sort((a, b) => compareStrings(a.file, b.file));
      diagnostics.push({ code: 'GENERATED_FILES_CHANGED', severity: 'info',
        message: `Changes in non-source files were reported but not traversed: ${nonSource.map(item => `${item.file} (${item.origin})`).join(', ')}` });
    }
  }
  // D11: the base graph is only built when something analyzable changed.
  const baseFingerprints = new Map<string, string>();
  const baseClassFingerprints = new Map<string, EntityFingerprints>();
  const baseExtraction = engine === 'extended' && supportedChanges.length > 0 && extracted.files.length > 0
    ? extractBaseGraph(repo, engine, { headCompilerOptions: snapshot.compilerOptions, onEntityNode: fingerprintCollector(baseFingerprints, baseClassFingerprints) })
    : undefined;
  const baseGraph = baseExtraction?.graph;
  // Base reads of changed files obey the same input limits as head reads (D9); a rejected base reads as absent.
  const baseSkipped = new Map<string, SkippedInput>();
  const readBase = (oldFile: string): string | undefined => {
    const blob = repo.getBaselineBlob(oldFile, repo.comparison.resolvedBaseSha);
    const reason = blob.length > DEFAULT_INPUT_LIMITS.maxFileBytes ? 'too_large' : inspectContent(blob);
    if (reason === 'ok') return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('utf8');
    baseSkipped.set(oldFile, { file: oldFile, reason });
    return undefined;
  };
  const unsupportedChanges = changedFiles.filter(change => !isAnalyzableFile(change.file, engine));
  if (unsupportedChanges.length > 0) {
    if (engine === 'extended') {
      // D11: typed diagnostics per non-TypeScript change replace the generic scope warning.
      diagnostics.push(...nonTsChangeDiagnostics(unsupportedChanges.map(change => ({ file: change.file,
        status: !change.oldFile ? 'added' as const : change.oldFile !== change.file ? 'renamed' as const
          : fs.existsSync(path.join(repo.projectRoot, change.file)) ? 'modified' as const : 'deleted' as const })), {
        base: file => {
          try { return readBase(unsupportedChanges.find(change => change.file === file)?.oldFile ?? file); }
          catch { return undefined; }
        },
        head: file => snapshot.readInput(path.join(repo.projectRoot, file)),
      }));
    } else {
      diagnostics.push({ code: 'OUTSIDE_SUPPORTED_SCOPE', severity: 'warning',
        message: 'Changes outside TypeScript extraction scope were not analyzed for function impact.' });
    }
  }
  const { changedEntities: headChangedEntities, diagnostics: entityWarnings, extraDiagnostics } = findChangedEntities({
    changedFiles: supportedChanges,
    entities: extracted.entities,
    parentById: extracted.parentById,
    getBaselineSource: oldFile => engine === 'extended' ? readBase(oldFile) : repo.getBaselineSource(oldFile, repo.comparison.resolvedBaseSha),
  }, engine);
  for (const message of entityWarnings) diagnostics.push({ code: 'AMBIGUOUS_FUNCTION_RANGE', severity: 'warning', message });
  if (engine === 'extended') diagnostics.push(...extraDiagnostics);
  let changedEntities = headChangedEntities;
  let impacts: EntityImpact[];
  const skippedEntities: NonNullable<DeterministicEvidence['skippedEntities']> = [];
  const baseOnly = new Map<string, EntityCoordinates>();
  if (baseGraph) {
    const correspondence = correspondChangedFiles({ changedFiles: supportedChanges, head: extracted, base: baseGraph,
      headFingerprints, baseFingerprints });
    for (const group of correspondence.ambiguous) {
      diagnostics.push({ code: 'AMBIGUOUS_CORRESPONDENCE', severity: 'warning',
        message: `Ambiguous correspondence between base [${group.base.map(entity => entity.id).join(', ')}] and head [${group.head.map(entity => entity.id).join(', ')}]; treated as deleted plus added.` });
    }
    changedEntities = applyCorrespondence({ changedEntities: headChangedEntities, changedFiles: supportedChanges,
      head: extracted, base: baseGraph, correspondence });
    const toHead = baseToHeadId(correspondence);
    changedEntities = changedEntities.map(changed => ({ ...changed, changeClasses: classifyChange({
      changeKind: changed.changeKind!, file: changed.entity.file,
      base: baseClassFingerprints.get(changed.baseEntity?.id ?? changed.entity.id),
      head: headClassFingerprints.get(changed.entity.id) }) }));
    impacts = [];
    for (const changed of changedEntities) {
      const skipReason = skipReasonOf(changed);
      if (skipReason) {
        skippedEntities.push({ entityId: changed.entity.id, reason: skipReason });
        continue;
      }
      const impact = changed.changeKind === 'deleted'
        ? buildDeletedImpact(changed, baseGraph, extracted, toHead, maxAffected, options.maxDepth, options.hubThreshold)
        : buildImpact(changed, extracted.reverseAdjacency, extracted.entityById, options.maxDepth, engine, maxAffected, options.hubThreshold);
      impacts.push(changed.changeClasses!.some(value => value === 'signature' || value === 'export_surface')
        ? withContractRisk(impact) : impact);
    }
    const noteBaseOnly = (entity: Entity) => {
      if (!extracted.entityById.has(entity.id)) baseOnly.set(entity.id, entityCoordinates(entity));
    };
    for (const changed of changedEntities) {
      if (changed.baseEntity) baseOnly.set(changed.baseEntity.id, changed.baseEntity);
    }
    for (const impact of impacts) {
      noteBaseOnly(impact.changedEntity);
      for (const path of impact.blastRadius.paths) path.path.forEach(noteBaseOnly);
    }
  } else {
    impacts = changedEntities.map(changed => buildImpact(changed, extracted.reverseAdjacency, extracted.entityById,
      options.maxDepth, engine, maxAffected, options.hubThreshold));
  }
  if (engine === 'extended') impacts = withChangedValueTargets({ extracted, changedEntities, changedFiles: supportedChanges, impacts });
  const baseEntities = [...baseOnly.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const impact of impacts) {
    if (impact.blastRadius.truncated) {
      const hubs = impact.blastRadius.hubs ?? [];
      diagnostics.push({ code: 'BLAST_RADIUS_TRUNCATED', severity: 'info', entityId: impact.changedEntity.id,
        message: hubs.length > 0
          ? `Blast radius for ${impact.changedEntity.id} stopped expanding at ${hubs.length} hub(s): ${hubs.map(hub => hub.entityId).join(', ')}; dependents beyond a hub are counted in its reach but not listed.`
          : `Blast radius for ${impact.changedEntity.id} was cut at ${maxAffected} affected entities; shallowest and lowest-ID entities are kept.` });
    }
  }
  skippedEntities.sort((a, b) => compareStrings(a.entityId, b.entityId));
  const cosmeticIds = skippedEntities.filter(item => item.reason === 'cosmetic').map(item => item.entityId);
  if (cosmeticIds.length > 0) {
    diagnostics.push({ code: 'COSMETIC_CHANGES_SKIPPED', severity: 'info',
      message: `Formatting- or comment-only changes were not traversed: ${cosmeticIds.join(', ')}` });
  }
  // Every read has happened by now, so the skip list is final (the compiler can skip more inputs after capture).
  const SKIP_CODES: Record<SkippedInput['reason'], string> = {
    too_large: 'FILE_TOO_LARGE', binary: 'BINARY_FILE', invalid_encoding: 'INVALID_ENCODING',
    symlink: 'SYMLINK_SKIPPED', input_limit: 'INPUT_LIMIT_EXCEEDED', parse_failed: 'PARSE_FAILED',
  };
  const skippedInputs: SkippedInput[] = [];
  if (engine === 'extended') {
    const seen = new Set<string>();
    for (const item of [...snapshot.skipped, ...(baseExtraction?.skipped ?? []), ...baseSkipped.values()]) {
      if (seen.has(item.file)) continue;
      seen.add(item.file);
      skippedInputs.push(item);
    }
    skippedInputs.sort((a, b) => compareStrings(a.file, b.file));
    for (const item of skippedInputs) {
      diagnostics.push({ code: SKIP_CODES[item.reason], severity: 'warning', file: item.file,
        message: `${item.file} was not analyzed (${item.reason.replace(/_/g, ' ')}).` });
    }
    const skippedHead = new Set(snapshot.skipped.map(item => item.file));
    extracted.technicalGraph.analyzedFiles = extracted.technicalGraph.analyzedFiles.filter(file => !skippedHead.has(file));
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
  // D7: the report lists frontier sites only for changed entities and entities in a blast radius.
  const relevantIds = new Set<string>(changedEntities.map(changed => changed.entity.id));
  for (const impact of impacts) {
    relevantIds.add(impact.changedEntity.id);
    for (const entity of impact.directDependents) relevantIds.add(entity.id);
    for (const impactPath of impact.blastRadius.paths) for (const entity of impactPath.path) relevantIds.add(entity.id);
  }
  const frameworkVersions = detectFrameworkVersions({ projectRoot: repo.projectRoot, repoRoot: repo.gitRepositoryRoot });
  const mapResult = buildApplicationMap(extracted, repo.projectRoot, headSha, frameworkVersions);
  const schema3 = extended && options.evidenceSchema === '3.0';
  // Schema 3.0 (D8, D10): surfaces, endpoint links, tests and test mapping; failures never block evidence.
  const frameworkVersionsFor = createFrameworkVersionResolver({ projectRoot: repo.projectRoot, repoRoot: repo.gitRepositoryRoot });
  const phase5 = schema3 ? buildPhase5Evidence({ extracted, mapResult, frameworkVersions, frameworkVersionsFor, impacts, config }) : undefined;
  if (phase5) {
    impacts = phase5.impacts;
    diagnostics.push(...phase5.diagnostics);
  }
  const allFrontier = phase5 && phase5.frontier.length > 0
    ? [...extracted.frontier, ...phase5.frontier].sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line ||
      compareStrings(a.reason, b.reason) || compareStrings(a.entityId, b.entityId))
    : extracted.frontier;
  const frontier = extended ? allFrontier.filter(item => relevantIds.has(item.entityId)) : undefined;
  let coverage: DeterministicEvidence['coverage'];
  if (extended) {
    const attributedLines = new Map<string, Set<number>>();
    for (const { entity, change } of changedEntities) {
      if (entity.kind === 'module') continue;
      const lines = attributedLines.get(change.file) ?? new Set<number>();
      for (const line of change.changedLines) lines.add(line);
      attributedLines.set(change.file, lines);
    }
    // Frontier sites outside changed files count only in frontierTotal (D12).
    const changedPaths = new Set(changedFiles.map(change => change.file));
    const skipped = new Map<string, EvidenceSkipReason>();
    for (const item of skippedInputs) skipped.set(item.file, mapSnapshotSkipReason(item.reason));
    for (const item of nonSource) if (!skipped.has(item.file)) skipped.set(item.file, 'generated');
    for (const change of unsupportedChanges) if (!skipped.has(change.file)) skipped.set(change.file, 'unsupported_language');
    coverage = buildCoverage({
      changedFiles, attributedLines, frontier: frontier!.filter(item => changedPaths.has(item.file)), frontierTotal: allFrontier.length,
      skipped: [...skipped].map(([file, reason]) => ({ file, reason })),
    });
  }
  const evidence: DeterministicEvidence = {
    artifactKind: EVIDENCE_ARTIFACT_KIND,
    schemaVersion: schema3 ? EVIDENCE_SCHEMA_VERSION_3 : extended ? EXTENDED_EVIDENCE_SCHEMA_VERSION : EVIDENCE_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    target: { targetPath },
    comparison: repo.comparison,
    sourceState: { ...repo.sourceState, contentIdentity: snapshot.identity() },
    options: extended ? { excludePaths: repo.excludePaths, sourcePolicy, engine: 'extended' }
      : { excludePaths: repo.excludePaths, sourcePolicy },
    ...(extended ? { toolchain: buildToolchainRecord() } : {}),
    outcome, technicalGraph: extracted.technicalGraph, changedFiles, changedEntities, impacts,
    diagnostics, limitations: [...(schema3 ? SCHEMA_3_LIMITATIONS : extended ? EXTENDED_LIMITATIONS : DEFAULT_LIMITATIONS)],
    ...(baseEntities.length > 0 ? { baseEntities } : {}),
    ...(skippedEntities.length > 0 ? { skippedEntities } : {}),
    ...(frontier ? { frontier } : {}),
    ...(coverage ? { coverage } : {}),
    ...(phase5 ? {
      surfaces: phase5.surfaces, surfaceEdges: phase5.surfaceEdges, tests: phase5.tests,
      ...(phase5.testMapping ? { testMapping: phase5.testMapping } : {}),
      ...(loadedConfig?.sha256 && config ? { config: { file: CONFIG_FILE_NAME, sha256: loadedConfig.sha256 } } : {}),
      adapters: phase5.adapters,
    } : {}),
  };
  snapshot.verify();
  assertValidEvidenceEnvelope(evidence);
  const applicationMap = mapResult.map;
  const summaryMessage = outcome === 'completed'
    ? `Deterministic impact evidence built for ${impacts.length} changed functions.${skippedEntities.length > 0 ? ` ${skippedEntities.length} cosmetic or test-only changes were not traversed.` : ''}`
    : outcome === 'no_changes' ? 'No changes were found in the included target scope.'
    : outcome === 'no_source_files' ? 'No TypeScript files were found in the target repository.'
    : 'Changes did not match supported current function declarations.';
  return { outcome, technicalGraph: extracted.technicalGraph, evidence, applicationMap, changedFiles, changedEntities,
    impacts, gitDiff, diagnostics, summaryMessage, ...(attribution ? { attribution } : {}) };
}

type BaseNodeHook = NonNullable<Parameters<typeof extractTechnicalGraph>[0]['onEntityNode']>;

/** test_only wins over cosmetic so a skipped entity carries one reason; any other class keeps normal traversal. */
function skipReasonOf(changed: ChangedEntity): 'cosmetic' | 'test_only' | undefined {
  const classes = changed.changeClasses ?? [];
  return classes.includes('test_only') ? 'test_only' : classes.includes('cosmetic') ? 'cosmetic' : undefined;
}

/**
 * Fingerprints are computed while the AST is alive (D3); module entities pair by id only and are not fingerprinted for
 * correspondence. For classification a module is compared as its whole file (`full` and `noLogs` only): it is cosmetic
 * only when the entire normalized file is unchanged, otherwise 'body' (or 'log_only'), so no module-level change is hidden.
 */
function fingerprintCollector(into: Map<string, string>, classes: Map<string, EntityFingerprints>): BaseNodeHook {
  return (entity, node) => {
    try {
      if (entity.kind === 'module') {
        classes.set(entity.id, { full: fingerprint(normalizeNode(node)), noLogs: fingerprint(normalizeNode(node, { dropLogCalls: true })),
          signature: '', exportSurface: '' });
        return;
      }
      into.set(entity.id, fingerprint(normalizeNode(node, { renameParams: true })));
      classes.set(entity.id, fingerprintsOf(node));
    } catch {
      // An unfingerprintable entity never pairs by fingerprint, so it stays deleted plus added; unclassifiable ones read as 'body'.
    }
  };
}

/** Graph of the base revision, built from Git objects through a host that never touches the head snapshot's reads. */
export function extractBaseGraph(
  repo: RepositoryContext,
  engine: EngineProfile,
  options: { headCompilerOptions: CompilerOptions; onEntityNode?: BaseNodeHook },
): { graph: ExtractedGraph; diagnostics: DiagnosticItem[]; skipped: SkippedInput[] } {
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
  return { graph, diagnostics: [...baseline.diagnostics, ...graph.diagnostics], skipped: baseline.skipped };
}

function emptyApplicationMap(headSha: string, reason?: string): ApplicationMap {
  return {
    schemaVersion: APPLICATION_MAP_SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, headSha,
    platform: { frontend: false, backend: false, frameworks: [] },
    surfaces: [], navigation: [], requests: [], e2eFlows: [], relations: [], entityFingerprints: {},
    limitations: reason ? [reason] : [],
  };
}

/** The analyzed project root as the repository context resolves it (real path when it exists). */
function resolveTargetRoot(target: string): string {
  const resolved = path.resolve(target);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

/** The application map is best-effort: a failure never blocks deterministic evidence. */
function buildApplicationMap(extracted: ExtractedGraph, projectRoot: string, headSha: string, frameworkVersions: readonly FrameworkDetection[]):
  { map: ApplicationMap; provenance: SurfaceProvenance; context?: AdapterContext; failure?: string } {
  if (!extracted.program || !extracted.checker || !extracted.symbolToEntity || !extracted.toProjectPath) {
    return { map: emptyApplicationMap(headSha), provenance: new Map() };
  }
  try {
    return extractApplicationMapWithProvenance({
      program: extracted.program, checker: extracted.checker, symbolToEntity: extracted.symbolToEntity,
      entities: extracted.entities, relations: extracted.relations, files: extracted.files,
      toProjectPath: extracted.toProjectPath, projectRoot, headSha, frameworkVersions,
    });
  } catch (error) {
    const failure = `Application map extraction failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    return { map: emptyApplicationMap(headSha, failure), provenance: new Map(), failure };
  }
}

/** Project-relative inventory (tracked + non-ignored untracked) used for business-signal collection. */
export function listProjectFiles(options: Pick<AnalyzeOptions, 'target' | 'comparison' | 'excludePaths' | 'gitTimeoutMs'>): string[] {
  const repo = createRepositoryContext(options.target, options.comparison, {
    gitTimeoutMs: options.gitTimeoutMs, excludePaths: options.excludePaths,
  });
  return [...new Set([...repo.listFiles(), ...repo.listFiles(true)])].sort();
}
