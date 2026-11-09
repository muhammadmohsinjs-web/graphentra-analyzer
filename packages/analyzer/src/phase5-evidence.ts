import type { ApplicationMap, SurfaceProvenance } from './application-map';
import { routeMatches } from './application-map-ast';
import type { AdapterContext } from './adapters/types';
import { ADAPTER_VERSION } from './adapters/types';
import { criticalityFor, type GraphentraConfig } from './config';
import type {
  AdapterRecord, DiagnosticItem, EdgeConfidence, EntityImpact, FrontierItem, SurfaceEdge, SurfaceNode, TestMapping, TestNode,
} from './contracts';
import { compareStrings } from './deterministic';
import { collectClientCalls, linkEndpoints } from './endpoint-links';
import type { FrameworkDetection } from './framework-version';
import { buildSurfaceEvidence } from './surface-evidence';
import { withAffectedSurfaces } from './surface-impact';
import type { ExtractedGraph } from './technical-graph';
import { extractTests } from './test-mapping';

/** Adapter id recorded on surfaces declared in graphentra.yml (D12). */
export const CONFIG_ADAPTER_ID = 'config';

export interface Phase5MapResult {
  map: ApplicationMap;
  provenance: SurfaceProvenance;
  context?: AdapterContext;
  failure?: string;
}

export interface Phase5Input {
  extracted: ExtractedGraph;
  mapResult: Phase5MapResult;
  frameworkVersions: readonly FrameworkDetection[];
  impacts: EntityImpact[];
  config?: GraphentraConfig;
  /** Stage overrides; tests use them to force the D10 failure paths. */
  stages?: Partial<Phase5Stages>;
}

export interface SurfaceStageResult {
  surfaces: SurfaceNode[];
  /** SURFACE_HANDLED_BY and CALLS_ENDPOINT. */
  surfaceEdges: SurfaceEdge[];
  adapters: AdapterRecord[];
  /** dynamic_endpoint_url items, sorted by file, line, reason, entityId. */
  frontier: FrontierItem[];
  diagnostics: DiagnosticItem[];
}

export interface TestStageResult {
  tests: TestNode[];
  /** TEST_COVERS only. */
  edges: SurfaceEdge[];
}

export interface Phase5Stages {
  surfaces: (input: Phase5Input, entityIds: ReadonlySet<string>) => SurfaceStageResult;
  tests: (input: Phase5Input, entityIds: ReadonlySet<string>, surfaces: readonly SurfaceNode[]) => TestStageResult;
}

export interface Phase5Evidence {
  surfaces: SurfaceNode[];
  surfaceEdges: SurfaceEdge[];
  tests: TestNode[];
  adapters: AdapterRecord[];
  /**
   * Absent when surface or test extraction failed: without tests every surface would read as uncovered, and without
   * surfaces `uncoveredSurfaces: []` would read as "everything covered".
   */
  testMapping?: TestMapping;
  frontier: FrontierItem[];
  impacts: EntityImpact[];
  diagnostics: DiagnosticItem[];
}

const edgeKey = (edge: SurfaceEdge): string => `${edge.from}|${edge.type}|${edge.to}`;
const sortEdges = (edges: SurfaceEdge[]): SurfaceEdge[] => edges.sort((a, b) => compareStrings(edgeKey(a), edgeKey(b)));
const sameRoute = (route: string, target: string): boolean => route.replace(/\/+$/, '') === target.replace(/\/+$/, '');
const message = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

/** Detected surfaces + graphentra.yml surfaces + criticality, plus CALLS_ENDPOINT edges and dynamic URL frontier (P5-4, P5-5). */
export function surfaceStage(input: Phase5Input, entityIds: ReadonlySet<string>): SurfaceStageResult {
  if (input.mapResult.failure) throw new Error(input.mapResult.failure);
  const built = buildSurfaceEvidence({ map: input.mapResult.map, provenance: input.mapResult.provenance,
    frameworkVersions: input.frameworkVersions, entityIds });
  const diagnostics = [...built.diagnostics];
  const byId = new Map(built.surfaces.map(surface => [surface.id, surface]));
  let handled = built.surfaceEdges;
  const config = input.config;
  if (config && config.surfaces.length > 0) {
    // D12: a manual mapping is proven and replaces a detected surface with the same id.
    const overridden = new Set<string>();
    for (const declared of config.surfaces) {
      const entity = input.extracted.entityById.get(declared.handler);
      if (!entity || !entityIds.has(entity.id)) {
        diagnostics.push({ code: 'CONFIG_SURFACE_HANDLER_NOT_FOUND', severity: 'warning', file: 'graphentra.yml',
          message: `Surface "${declared.id}" names handler "${declared.handler}", which is not an entity of the analyzed graph; the surface is ignored.` });
        continue;
      }
      overridden.add(declared.id);
      byId.set(declared.id, {
        id: declared.id, kind: declared.kind, route: declared.route, ...(declared.method ? { method: declared.method } : {}),
        file: entity.file, line: entity.startLine, handlerEntityIds: [entity.id],
        adapter: { id: CONFIG_ADAPTER_ID, version: ADAPTER_VERSION }, confidence: 'proven', source: 'config',
      });
    }
    handled = handled.filter(edge => !overridden.has(edge.from));
    for (const id of overridden) handled.push({ from: id, to: byId.get(id)!.handlerEntityIds[0]!, type: 'SURFACE_HANDLED_BY', confidence: 'proven' });
  }
  const surfaces = [...byId.values()].map(surface => {
    const level = config ? criticalityFor(config, surface.id) : undefined;
    return level ? { ...surface, criticality: level } : surface;
  }).sort((a, b) => compareStrings(a.id, b.id));

  let calls: SurfaceEdge[] = [];
  let frontier: FrontierItem[] = [];
  if (input.mapResult.context) {
    // Calls at module top level have no enclosing entity and are not linked (collectClientCalls skips them).
    const links = linkEndpoints(collectClientCalls(input.mapResult.context), surfaces);
    calls = links.edges.filter(edge => entityIds.has(edge.from));
    frontier = links.frontier.filter(item => entityIds.has(item.entityId))
      .sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.reason, b.reason) || compareStrings(a.entityId, b.entityId));
  }
  return { surfaces, surfaceEdges: sortEdges([...handled, ...calls]), adapters: built.adapters, frontier, diagnostics };
}

/** Test nodes and TEST_COVERS edges (P5-7): test → entity via import, test → ui surface via goto/visit. */
export function testStage(input: Phase5Input, entityIds: ReadonlySet<string>, surfaces: readonly SurfaceNode[]): TestStageResult {
  const { extracted } = input;
  if (!extracted.program || !extracted.checker || !extracted.symbolToEntity || !extracted.toProjectPath) return { tests: [], edges: [] };
  const result = extractTests({
    program: extracted.program, checker: extracted.checker, symbolToEntity: extracted.symbolToEntity,
    files: extracted.files, toProjectPath: extracted.toProjectPath, testGlobs: input.config?.tests,
  });
  const edges = new Map<string, SurfaceEdge>();
  const add = (edge: SurfaceEdge) => {
    const existing = edges.get(edgeKey(edge));
    if (!existing || existing.confidence === 'likely' && edge.confidence === 'proven') edges.set(edgeKey(edge), edge);
  };
  for (const { testId, entityId } of result.coversEntities) {
    if (entityIds.has(entityId)) add({ from: testId, to: entityId, type: 'TEST_COVERS', confidence: 'proven', via: 'import' });
  }
  const routes = surfaces.filter(surface => surface.kind === 'ui_route');
  for (const { testId, route } of result.visitsRoutes) {
    for (const surface of routes) {
      if (!routeMatches(surface.route, route)) continue;
      const confidence: EdgeConfidence = sameRoute(surface.route, route) ? 'proven' : 'likely';
      add({ from: testId, to: surface.id, type: 'TEST_COVERS', confidence, via: 'goto' });
    }
  }
  return { tests: result.tests, edges: sortEdges([...edges.values()]) };
}

/**
 * D6/D8 static reach: a test reaches everything forward of its TEST_COVERS targets (entity relations, surface →
 * handler, calling entity → api surface). It is listed when it reaches a changed or impacted entity or an affected
 * surface; `reaches` holds the affected surfaces it reaches. Affected surfaces no test reaches are uncovered.
 */
export function computeTestMapping(input: {
  tests: readonly TestNode[];
  relations: ExtractedGraph['relations'];
  surfaceEdges: readonly SurfaceEdge[];
  impacts: readonly EntityImpact[];
}): TestMapping {
  const forward = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    let targets = forward.get(from);
    if (!targets) forward.set(from, targets = new Set());
    targets.add(to);
  };
  for (const relation of input.relations) link(relation.from, relation.to);
  for (const edge of input.surfaceEdges) link(edge.from, edge.to);

  const affected = new Set<string>();
  const touched = new Set<string>();
  for (const impact of input.impacts) {
    touched.add(impact.changedEntity.id);
    for (const entity of impact.directDependents) touched.add(entity.id);
    for (const impactPath of impact.blastRadius.paths) for (const entity of impactPath.path) touched.add(entity.id);
    for (const surface of impact.affectedSurfaces ?? []) affected.add(surface.surfaceId);
  }

  const covered = new Set<string>();
  const testsToRun: TestMapping['testsToRun'] = [];
  for (const test of [...input.tests].sort((a, b) => compareStrings(a.id, b.id))) {
    const seen = new Set<string>([test.id]);
    const queue = [test.id];
    while (queue.length > 0) {
      for (const next of forward.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    const reaches = [...seen].filter(id => affected.has(id)).sort(compareStrings);
    if (reaches.length === 0 && ![...seen].some(id => touched.has(id))) continue;
    for (const id of reaches) covered.add(id);
    testsToRun.push({ testId: test.id, reaches });
  }
  return { basis: 'static-reach', testsToRun, uncoveredSurfaces: [...affected].filter(id => !covered.has(id)).sort(compareStrings) };
}

/** Schema 3.0 surfaces, endpoint links, tests and test mapping; each stage fails on its own (D10). */
export function buildPhase5Evidence(input: Phase5Input): Phase5Evidence {
  const stages: Phase5Stages = { surfaces: surfaceStage, tests: testStage, ...input.stages };
  const entityIds = new Set(input.extracted.technicalGraph.entities.map(entity => entity.id));
  const diagnostics: DiagnosticItem[] = [];
  let surfaceResult: SurfaceStageResult = { surfaces: [], surfaceEdges: [], adapters: [], frontier: [], diagnostics: [] };
  let surfacesFailed = false;
  try {
    surfaceResult = stages.surfaces(input, entityIds);
  } catch (error) {
    surfacesFailed = true;
    diagnostics.push({ code: 'SURFACE_EXTRACTION_FAILED', severity: 'warning',
      message: `Surface extraction failed; evidence has no surfaces: ${message(error)}` });
  }
  diagnostics.push(...surfaceResult.diagnostics);
  const impacts = withAffectedSurfaces(input.impacts, { relations: input.extracted.technicalGraph.relations,
    surfaceEdges: surfaceResult.surfaceEdges, surfaceIds: surfaceResult.surfaces.map(surface => surface.id) });

  let testResult: TestStageResult | undefined;
  try {
    testResult = stages.tests(input, entityIds, surfaceResult.surfaces);
  } catch (error) {
    diagnostics.push({ code: 'TEST_EXTRACTION_FAILED', severity: 'warning',
      message: `Test extraction failed; evidence has no tests: ${message(error)}` });
  }
  const surfaceEdges = sortEdges([...surfaceResult.surfaceEdges, ...(testResult?.edges ?? [])]);
  const tests = testResult?.tests ?? [];
  return {
    surfaces: surfaceResult.surfaces, surfaceEdges, tests, adapters: surfaceResult.adapters,
    ...(testResult && !surfacesFailed ? { testMapping: computeTestMapping({ tests, relations: input.extracted.technicalGraph.relations, surfaceEdges, impacts }) } : {}),
    frontier: surfaceResult.frontier, impacts, diagnostics,
  };
}
