import * as ts from 'typescript';
import { collectEntities } from './entity-collector';
import {
  extractEntityChange,
  getFunctionRanges,
} from './change-evidence';
import {
  DEFAULT_ENGINE,
  MAX_BLAST_DEPTH,
  type EngineProfile,
  type ChangedEntity,
  type ChangedFile,
  type DiagnosticItem,
  type FunctionRange,
  type Entity,
  type EntityImpact,
  type ImpactPath,
  type Relation,
} from './contracts';

export function getCallers(
  entityId: string,
  reverseAdjacency: Map<string, Relation[]>,
  entityById: Map<string, Entity>,
): Entity[] {
  const incoming = reverseAdjacency.get(entityId) ?? [];
  const unique = new Map<string, Entity>();

  for (const relation of incoming) {
    const caller = entityById.get(relation.from);
    if (caller) {
      unique.set(caller.id, caller);
    }
  }

  return [...unique.values()];
}

export function getBlastRadiusPaths(
  entityId: string,
  reverseAdjacency: Map<string, Relation[]>,
  entityById: Map<string, Entity>,
  maxDepth: number = MAX_BLAST_DEPTH,
): ImpactPath[] {
  const start = entityById.get(entityId);
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

    if (depth >= maxDepth) {
      continue;
    }

    const callers = getCallers(current.entity.id, reverseAdjacency, entityById);

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

export function buildImpact(
  changedEntity: ChangedEntity,
  reverseAdjacency: Map<string, Relation[]>,
  entityById: Map<string, Entity>,
  maxDepth: number = MAX_BLAST_DEPTH,
): EntityImpact {
  const paths = getBlastRadiusPaths(
    changedEntity.entity.id,
    reverseAdjacency,
    entityById,
    maxDepth,
  );

  const affected = new Map<string, Entity>();
  const direct = new Map<string, Entity>();

  for (const impact of paths) {
    affected.set(impact.target.id, impact.target);

    if (impact.depth === 1) {
      direct.set(impact.target.id, impact.target);
    }
  }

  const affectedEntities = [...affected.values()];
  const terminalDependents = affectedEntities.filter(
    entity => getCallers(entity.id, reverseAdjacency, entityById).length === 0,
  );

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

export function findChangedEntities(options: {
  changedFiles: ChangedFile[];
  entities: Entity[];
  getBaselineSource: (oldFile: string) => string | undefined;
  /** Extended engine: entity id to enclosing entity id. */
  parentById?: Map<string, string | undefined>;
  onWarning?: (message: string) => void;
}, engine: EngineProfile = DEFAULT_ENGINE): {
  changedEntities: ChangedEntity[];
  diagnostics: string[];
  /** Structured diagnostics (extended engine only; always empty for legacy). */
  extraDiagnostics: DiagnosticItem[];
} {
  const { changedFiles, entities, getBaselineSource, onWarning, parentById } = options;
  const extended = engine === 'extended';
  const isAncestor = (ancestorId: string, id: string): boolean => {
    for (let current = parentById?.get(id); current !== undefined; current = parentById?.get(current)) {
      if (current === ancestorId) return true;
    }
    return false;
  };
  const changedEntities: ChangedEntity[] = [];
  const diagnostics: string[] = [];
  const extraDiagnostics: DiagnosticItem[] = [];
  const errorClass = (error: unknown): string => error instanceof Error ? error.constructor.name : typeof error;

  for (const change of changedFiles) {
    const matchingEntities = entities.filter(entity => entity.file === change.file);
    if (matchingEntities.length === 0) continue;

    let baseSource: string | undefined;
    let baselineFailure: string | undefined;
    try {
      baseSource = change.oldFile ? getBaselineSource(change.oldFile) : undefined;
    } catch (error) {
      if (!extended) throw error;
      baselineFailure = errorClass(error);
    }
    const previousRanges = !extended && change.oldFile && baseSource
      ? getFunctionRanges(change.oldFile, baseSource)
      : [];

    // Extended: the baseline goes through the same collector and is matched by entity ID, never by bare name.
    const baselineById = new Map<string, FunctionRange>();
    const baselineParent = new Map<string, string | undefined>();
    const baselineChildren = new Map<string, FunctionRange[]>();
    if (extended && change.oldFile && baseSource) {
      try {
        const sourceFile = ts.createSourceFile(change.oldFile, baseSource, ts.ScriptTarget.Latest, true);
        const collected = collectEntities(sourceFile, { relativeFile: change.file, engine: 'extended' });
        for (const candidate of collected) {
          const { id, name, startLine, endLine } = candidate.entity;
          const range = { name, startLine, endLine };
          baselineById.set(id, range);
          baselineParent.set(id, candidate.parent?.entity.id);
          if (candidate.parent) {
            const siblings = baselineChildren.get(candidate.parent.entity.id) ?? [];
            siblings.push(range);
            baselineChildren.set(candidate.parent.entity.id, siblings);
          }
        }
      } catch (error) {
        baselineFailure = errorClass(error);
        baselineById.clear();
        baselineParent.clear();
        baselineChildren.clear();
      }
    }
    if (baselineFailure !== undefined) {
      extraDiagnostics.push({
        code: 'BASELINE_ANALYSIS_FAILED',
        severity: 'warning',
        file: change.file,
        message: `Baseline entity collection failed (${baselineFailure}); removed-code evidence is unavailable for this file.`,
      });
    }
    const isBaselineAncestor = (ancestorId: string, id: string): boolean => {
      for (let current = baselineParent.get(id); current !== undefined; current = baselineParent.get(current)) {
        if (current === ancestorId) return true;
      }
      return false;
    };

    for (const entity of matchingEntities) {
      const candidates = previousRanges.filter(previous => previous.name === entity.name);
      // Ambiguous old identities must not leak another function's removed code.
      const previous = extended ? baselineById.get(entity.id) : candidates.length === 1 ? candidates[0] : undefined;
      const overlaps = (
        a: { startLine: number; endLine: number },
        b: { startLine: number; endLine: number },
      ) => a.startLine <= b.endLine && b.startLine <= a.endLine;

      // Extended: nested entities may overlap their ancestors; only partial overlap without ancestry is ambiguous.
      const ambiguous = extended
        ? matchingEntities.some(other => other !== entity && overlaps(entity, other) &&
            !isAncestor(entity.id, other.id) && !isAncestor(other.id, entity.id)) ||
          (!!previous && [...baselineById].some(([otherId, other]) => otherId !== entity.id && overlaps(previous, other) &&
            !isBaselineAncestor(entity.id, otherId) && !isBaselineAncestor(otherId, entity.id)))
        : matchingEntities.some(other => other !== entity && overlaps(entity, other)) ||
          (previous && previousRanges.some(other => other !== previous && overlaps(previous, other)));

      if (ambiguous) {
        const warning = `Skipping ambiguous overlapping function ranges: ${entity.id}`;
        diagnostics.push(warning);
        onWarning?.(warning);
        continue;
      }

      const entityChange = extended
        ? extractEntityChange(change, entity, previous, {
          current: matchingEntities.filter(other => parentById?.get(other.id) === entity.id),
          previous: baselineChildren.get(entity.id) ?? [],
        })
        : extractEntityChange(change, entity, previous);

      if (entityChange) {
        changedEntities.push({
          entity,
          change: entityChange,
        });
      }
    }
  }

  return {
    changedEntities,
    diagnostics,
    extraDiagnostics,
  };
}
