import type { ApplicationMap } from './application-map';

export const ANALYZER_VERSION: string = require('../package.json').version;
export const EVIDENCE_SCHEMA_VERSION = '2.0';
export const EXTENDED_EVIDENCE_SCHEMA_VERSION = '2.1';
/** Schema 3.0: 2.1 plus surfaces, surface edges, tests, test mapping, config and adapters. Opt-in. */
export const EVIDENCE_SCHEMA_VERSION_3 = '3.0';
export const EVIDENCE_SCHEMA_VERSIONS = ['2.0', '2.1', '3.0'] as const;
export const EVIDENCE_ARTIFACT_KIND = 'graphentra-evidence';

export const MAX_BLAST_DEPTH = 6;
/** Extended engine: cap on affected entities reported per changed entity (deterministic: shallowest, then lexicographic IDs). */
export const MAX_AFFECTED_ENTITIES = 2000;
/** Extended engine: pathCount saturates here so counting stays bounded on dense fan-in. */
/** Extended engine: direct fan-in at or above which a node is summarized as a hub instead of expanded. */
export const HUB_THRESHOLD = 25;
export const MAX_SHORTEST_PATH_COUNT = 1_000_000;

export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.graphentra',
]);

export const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
/** Analyzed only by the extended engine. */
export const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

export type EntityKind = 'function' | 'method' | 'component' | 'module';
export type EntityLanguage = 'typescript' | 'javascript';
export const LEGACY_ENTITY_KINDS: EntityKind[] = ['function'];
/** Sorted: the 2.1 validator requires capabilities.entityKinds in compareStrings order. */
export const EXTENDED_ENTITY_KINDS: EntityKind[] = ['component', 'function', 'method', 'module'];

export type RelationType = 'CALLS' | 'RENDERS' | 'REFERENCES' | 'INSTANTIATES';
export const LEGACY_RELATION_TYPES: RelationType[] = ['CALLS'];
/** Types the extended engine emits today; each edge task adds its type when it lands. Sorted, like EXTENDED_ENTITY_KINDS. */
export const EXTENDED_RELATION_TYPES: RelationType[] = ['CALLS', 'INSTANTIATES', 'REFERENCES', 'RENDERS'];
/** When one pair of entities has more than one relation, a path step reports the first type in this list. */
export const STEP_TYPE_PRECEDENCE: RelationType[] = ['RENDERS', 'INSTANTIATES', 'CALLS', 'REFERENCES'];

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  language?: EntityLanguage;
  container?: string;
  exported?: boolean;
  exportName?: string;
}

/** Schema 2.1: sorted ascending. An absent edge confidence means 'proven'. */
export const CONFIDENCE_LEVELS = ['likely', 'proven'] as const;
export type EdgeConfidence = typeof CONFIDENCE_LEVELS[number];
/** Schema 2.1: a path is as confident as its weakest edge. */
export type PathConfidence = EdgeConfidence;

export interface Relation {
  from: string;
  to: string;
  type: RelationType;
  /** Schema 2.1: absent means 'proven'. */
  confidence?: EdgeConfidence;
}

export interface EntityChange {
  file: string;
  changedLines: number[];
  addedCode: string[];
  removedCode: string[];
  diff: string;
}

export interface DiffLine {
  kind: ' ' | '+' | '-';
  code: string;
  oldLine: number;
  newLine: number;
}

export interface ChangedFile extends EntityChange {
  oldFile?: string;
  hunks: Array<{ lines: DiffLine[] }>;
}

export interface FunctionRange {
  name: string;
  startLine: number;
  endLine: number;
}

/** Schema 2.1: how a changed entity differs between the base and head snapshots. */
export type ChangeKind = 'added' | 'deleted' | 'modified' | 'renamed';

/** Schema 2.1: sorted ascending in evidence; the validator requires compareStrings order. */
export const CHANGE_CLASSES = ['added', 'body', 'cosmetic', 'deleted', 'export_surface', 'log_only', 'renamed', 'signature', 'test_only'] as const;
export type ChangeClass = typeof CHANGE_CLASSES[number];

/** Schema 2.1: where an entity lived in the base snapshot. */
export interface EntityCoordinates {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface ChangedEntity {
  entity: Entity;
  change: EntityChange;
  /** Schema 2.1: deleted entities may be absent from technicalGraph (head snapshot). */
  changeKind?: ChangeKind;
  /** Schema 2.1: base-snapshot location; required for 'deleted' and 'renamed', and listed in evidence.baseEntities when deleted. */
  baseEntity?: EntityCoordinates;
  /** Schema 2.1: sorted, unique. */
  changeClasses?: ChangeClass[];
  /** Schema 2.1: relation edges added/removed for this entity, each sorted by from|type|to and unique. */
  edgeDeltas?: { added: Relation[]; removed: Relation[] };
}

export interface ImpactPath {
  target: Entity;
  depth: number;
  path: Entity[];
  /** Extended engine: number of distinct shortest paths to target (capped at MAX_SHORTEST_PATH_COUNT). */
  pathCount?: number;
  /** Extended engine: stepTypes[i] is the type of the relation from path[i + 1] to path[i]. */
  stepTypes?: RelationType[];
  /** Schema 2.1: set on depth-1 paths when the changed entity's contract changed. */
  contractRisk?: boolean;
  /** Schema 2.1: weakest edge confidence along the path. */
  confidence?: PathConfidence;
}

/** An entity that gets a changed value, with the entity the value arrived through. */
export interface ValueFlowTarget {
  entity: Entity;
  through: string;
  /** Characters this code splits or searches its input on that the change now removes (for example 'tab'), sorted. */
  reliesOnRemovedCharacters?: string[];
}

export interface EntityImpact {
  changedEntity: Entity;
  change: EntityChange;
  directDependents: Entity[];
  blastRadius: {
    totalAffectedEntities: number;
    entities: Entity[];
    paths: ImpactPath[];
    /** Extended engine: true when affected entities were cut at maxAffectedEntities. */
    truncated?: boolean;
    /** Schema 2.1: hub nodes the traversal did not expand past, sorted by entityId. */
    hubs?: Array<{ entityId: string; fanIn: number; reach: number }>;
  };
  terminalDependents: Entity[];
  /** Schema 2.1: code that receives a changed value and is not otherwise flagged, sorted by entity id. Absent when empty. */
  receivesChangedValue?: ValueFlowTarget[];
  /** Schema 2.1: true when the changed entity's contract changed. */
  contractRisk?: boolean;
  /** Schema 2.1: weakest confidence over its paths; 'proven' when there are no paths. */
  confidence?: PathConfidence;
  /** Schema 3.0: surfaces reachable from the changed entity, sorted by depth then surfaceId. Absent when empty. */
  affectedSurfaces?: AffectedSurface[];
}

/** Schema 3.0: sorted ascending. All kinds are accepted by the schema; the MVP emits only api_endpoint and ui_route. */
export const SURFACE_KINDS = ['api_endpoint', 'cli_command', 'graphql_operation', 'library_export', 'mobile_screen', 'queue_consumer', 'rpc_method', 'scheduled_job', 'serverless_function', 'ui_route', 'webhook'] as const;
export type EvidenceSurfaceKind = typeof SURFACE_KINDS[number];

/** Schema 3.0: sorted ascending. */
export const SURFACE_EDGE_TYPES = ['CALLS_ENDPOINT', 'SURFACE_HANDLED_BY', 'TEST_COVERS'] as const;
export type SurfaceEdgeType = typeof SURFACE_EDGE_TYPES[number];

/** Schema 3.0: sorted ascending. */
export const TEST_FRAMEWORKS = ['cypress', 'jest', 'node-test', 'playwright', 'unknown', 'vitest'] as const;
export type TestFramework = typeof TEST_FRAMEWORKS[number];

/** Schema 3.0: surface confidence reuses the edge confidence levels. */
export const SURFACE_CONFIDENCE = CONFIDENCE_LEVELS;

/** Schema 3.0: an externally reachable entry point (route, endpoint, command, job). Ids: `ui:<route>`, `api:<METHOD> <route>`. */
export interface SurfaceNode {
  id: string;
  kind: EvidenceSurfaceKind;
  route: string;
  method?: string;
  file: string;
  line: number;
  /** Sorted, unique entity ids. */
  handlerEntityIds: string[];
  /** For example "nextjs@14". */
  framework?: string;
  adapter: { id: string; version: string };
  confidence: EdgeConfidence;
  source: 'detected' | 'config';
  criticality?: string;
}

/** Schema 3.0: sorted by from, type, to. Kept in evidence.surfaceEdges, never in technicalGraph.relations. */
export interface SurfaceEdge {
  from: string;
  to: string;
  type: SurfaceEdgeType;
  confidence: EdgeConfidence;
  /** TEST_COVERS only. */
  via?: 'goto' | 'import';
}

/** Schema 3.0: one node per it/test block; id is `test:<file>#<suite> > <name>`, duplicates get #2, #3 suffixes. */
export interface TestNode {
  id: string;
  file: string;
  line: number;
  name: string;
  framework: TestFramework;
}

/** Schema 3.0: a surface reached from a changed entity. path runs from the changed entity to the surface. */
export interface AffectedSurface {
  surfaceId: string;
  depth: number;
  path: string[];
  confidence: EdgeConfidence;
}

/** Schema 3.0: tests to run for the change, with the surfaces each one reaches. */
export interface TestMapping {
  basis: 'static-reach';
  /** Sorted by testId; reaches sorted. */
  testsToRun: Array<{ testId: string; reaches: string[] }>;
  /** Sorted surface ids reached by the change that no test covers. */
  uncoveredSurfaces: string[];
}

/** Schema 3.0: a framework adapter that ran. */
export interface AdapterRecord {
  id: string;
  version: string;
  framework?: string;
  detectedVersion?: string;
  certified: boolean;
}

/** Schema 2.1: why a call site cannot be resolved statically. Sorted ascending; the validator requires compareStrings order. */
export const FRONTIER_REASONS = ['any_typed_call', 'computed_member_call', 'di_token', 'dynamic_endpoint_url', 'dynamic_import', 'dynamic_require', 'eval', 'function_constructor', 'interface_dispatch', 'jsx_prop_component'] as const;
export type FrontierReason = typeof FRONTIER_REASONS[number];

/** Schema 2.1: an unresolved dependency site reported instead of an edge. */
export interface FrontierItem {
  entityId: string;
  file: string;
  line: number;
  reason: FrontierReason;
}

/** Schema 2.1: sorted ascending. */
export const SKIP_REASONS = ['binary', 'generated', 'invalid_encoding', 'parse_failure', 'symlink', 'too_large', 'unsupported_language'] as const;
export type SkipReason = typeof SKIP_REASONS[number];

/** Schema 2.1: one coverage row per language or top-level directory. */
export interface CoverageRow {
  key: string;
  changedLines: number;
  attributedLines: number;
  ratio: number;
  frontierCount: number;
}

export interface DiagnosticItem {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  file?: string;
  entityId?: string;
}

export interface TechnicalGraph {
  schemaVersion: '1.0';
  repository: {
    targetPath: string;
    headSha: string;
    analyzerVersion: string;
    generatedAt?: string;
  };
  capabilities: {
    language: 'typescript';
    entityKinds: EntityKind[];
    relationTypes: RelationType[];
    maxBlastDepth: number;
  };
  analyzedFiles: string[];
  entities: Entity[];
  relations: Relation[];
}

export type AnalysisOutcome =
  | 'completed'
  | 'no_source_files'
  | 'no_changes'
  | 'no_supported_changes';

export type ComparisonMode = 'commit' | 'working-tree';

export type ComparisonOptions =
  | {
      mode: 'commit';
      base: string;
      head: string;
    }
  | {
      mode: 'working-tree';
      base?: string;
    };

export interface EvidenceComparison {
  mode: ComparisonMode;
  requestedBase?: string;
  requestedHead?: string;
  resolvedBaseSha: string;
  resolvedHeadSha?: string;
  comparedTo: string;
}

export interface EvidenceSourceState {
  checkoutSha: string;
  isTrackedDirty: boolean;
  untrackedSourcePolicy: 'excluded' | 'included';
  contentIdentity: string;
}

export interface DeterministicEvidence {
  artifactKind: typeof EVIDENCE_ARTIFACT_KIND;
  schemaVersion: '2.0' | '2.1' | '3.0';
  analyzerVersion: string;
  target: {
    targetPath: string;
  };
  comparison: EvidenceComparison;
  sourceState: EvidenceSourceState;
  options: { excludePaths: string[]; sourcePolicy: 'git-tracked-and-nonignored-untracked' | 'git-tracked'; engine?: 'extended' };
  toolchain?: { typescript: string; node: string };
  outcome: AnalysisOutcome;
  technicalGraph: TechnicalGraph;
  changedFiles: ChangedFile[];
  changedEntities: ChangedEntity[];
  impacts: EntityImpact[];
  diagnostics: DiagnosticItem[];
  limitations: string[];
  /** Schema 2.1: base-snapshot coordinates of deleted entities, sorted and unique by id. */
  baseEntities?: EntityCoordinates[];
  /** Schema 2.1: changed entities skipped from impact analysis, sorted by entityId. */
  skippedEntities?: Array<{ entityId: string; reason: 'cosmetic' | 'test_only' }>;
  /** Schema 2.1: unresolved dependency sites on changed or affected entities, sorted by file, line, reason, entityId. */
  frontier?: FrontierItem[];
  /** Schema 2.1: analysis coverage; rows sorted by key, skippedFiles sorted by file. */
  coverage?: {
    byLanguage: CoverageRow[];
    byDirectory: CoverageRow[];
    skippedFiles: Array<{ file: string; reason: SkipReason }>;
    frontierTotal: number;
  };
  /** Schema 3.0: sorted by id. */
  surfaces?: SurfaceNode[];
  /** Schema 3.0: sorted by from, type, to. */
  surfaceEdges?: SurfaceEdge[];
  /** Schema 3.0: sorted by id. */
  tests?: TestNode[];
  /** Schema 3.0 */
  testMapping?: TestMapping;
  /** Schema 3.0: the graphentra.yml that shaped this analysis. */
  config?: { file: 'graphentra.yml'; sha256: string };
  /** Schema 3.0: sorted by id. */
  adapters?: AdapterRecord[];
}

export type EngineProfile = 'legacy' | 'extended';
export const ENGINE_PROFILES: readonly EngineProfile[] = ['legacy', 'extended'];
export const DEFAULT_ENGINE: EngineProfile = 'extended';

export interface AnalyzeOptions {
  target: string;
  comparison: ComparisonOptions;
  excludePaths?: string[];
  gitTimeoutMs?: number;
  engine?: EngineProfile;
  /** Extended engine: cap on affected entities per changed entity (default MAX_AFFECTED_ENTITIES). */
  maxAffectedEntities?: number;
  /** Extended engine: blast-radius depth limit (default MAX_BLAST_DEPTH). */
  maxDepth?: number;
  /** Extended engine: direct fan-in at which a node is summarized as a hub (default HUB_THRESHOLD). */
  hubThreshold?: number;
  /** Schema 3.0: evidence schema to emit (default '2.1'). Only the extended engine can emit '3.0'. */
  evidenceSchema?: '2.1' | '3.0';
}

export interface AnalyzeResult {
  outcome: AnalysisOutcome;
  technicalGraph: TechnicalGraph;
  evidence: DeterministicEvidence;
  /** Derived product-facing map (surfaces, navigation, flows). Not part of the evidence identity. */
  applicationMap: ApplicationMap;
  changedFiles: ChangedFile[];
  changedEntities: ChangedEntity[];
  impacts: EntityImpact[];
  gitDiff: string;
  diagnostics: DiagnosticItem[];
  summaryMessage: string;
  /** Extended engine only: share of changed lines attributed to code entities. Not part of the evidence. */
  attribution?: { total: number; code: number; module: number; unattributed: number; ratio: number };
}
