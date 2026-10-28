import type { ApplicationMap } from './application-map';

export const ANALYZER_VERSION: string = require('../package.json').version;
export const EVIDENCE_SCHEMA_VERSION = '2.0';
export const EXTENDED_EVIDENCE_SCHEMA_VERSION = '2.1';
export const EVIDENCE_SCHEMA_VERSIONS = ['2.0', '2.1'] as const;
export const EVIDENCE_ARTIFACT_KIND = 'graphentra-evidence';

export const MAX_BLAST_DEPTH = 6;
/** Extended engine: cap on affected entities reported per changed entity (deterministic: shallowest, then lexicographic IDs). */
export const MAX_AFFECTED_ENTITIES = 2000;
/** Extended engine: pathCount saturates here so counting stays bounded on dense fan-in. */
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

export interface Relation {
  from: string;
  to: string;
  type: RelationType;
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
  };
  terminalDependents: Entity[];
  /** Schema 2.1: true when the changed entity's contract changed. */
  contractRisk?: boolean;
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
  schemaVersion: '2.0' | '2.1';
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
