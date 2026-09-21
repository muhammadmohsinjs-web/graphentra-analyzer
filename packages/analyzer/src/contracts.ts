export const ANALYZER_VERSION: string = require('../package.json').version;
export const EVIDENCE_SCHEMA_VERSION = '2.0';
export const EVIDENCE_ARTIFACT_KIND = 'graphentra-evidence';

export const MAX_BLAST_DEPTH = 6;

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

export interface Entity {
  id: string;
  kind: 'function';
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface Relation {
  from: string;
  to: string;
  type: 'CALLS';
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

export interface ChangedEntity {
  entity: Entity;
  change: EntityChange;
}

export interface ImpactPath {
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
    entityKinds: ['function'];
    relationTypes: ['CALLS'];
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
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  analyzerVersion: string;
  target: {
    targetPath: string;
  };
  comparison: EvidenceComparison;
  sourceState: EvidenceSourceState;
  options: { excludePaths: string[]; sourcePolicy: 'git-tracked-and-nonignored-untracked' | 'git-tracked' };
  outcome: AnalysisOutcome;
  technicalGraph: TechnicalGraph;
  changedFiles: ChangedFile[];
  changedEntities: ChangedEntity[];
  impacts: EntityImpact[];
  diagnostics: DiagnosticItem[];
  limitations: string[];
}

export interface AnalyzeOptions {
  target: string;
  comparison: ComparisonOptions;
  excludePaths?: string[];
  gitTimeoutMs?: number;
}

export interface AnalyzeResult {
  outcome: AnalysisOutcome;
  technicalGraph: TechnicalGraph;
  evidence: DeterministicEvidence;
  changedFiles: ChangedFile[];
  changedEntities: ChangedEntity[];
  impacts: EntityImpact[];
  gitDiff: string;
  diagnostics: DiagnosticItem[];
  summaryMessage: string;
}
