import {
  extractEntityChange,
  getFunctionRanges,
} from './change-evidence';
import {
  MAX_BLAST_DEPTH,
  type ChangedEntity,
  type ChangedFile,
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
  onWarning?: (message: string) => void;
}): {
  changedEntities: ChangedEntity[];
  diagnostics: string[];
} {
  const { changedFiles, entities, getBaselineSource, onWarning } = options;
  const changedEntities: ChangedEntity[] = [];
  const diagnostics: string[] = [];

  for (const change of changedFiles) {
    const matchingEntities = entities.filter(entity => entity.file === change.file);
    if (matchingEntities.length === 0) continue;

    const baseSource = change.oldFile ? getBaselineSource(change.oldFile) : undefined;
    const previousRanges = change.oldFile && baseSource
      ? getFunctionRanges(change.oldFile, baseSource)
      : [];

    for (const entity of matchingEntities) {
      const candidates = previousRanges.filter(previous => previous.name === entity.name);
      // Ambiguous old identities must not leak another function's removed code.
      const previous = candidates.length === 1 ? candidates[0] : undefined;
      const overlaps = (
        a: { startLine: number; endLine: number },
        b: { startLine: number; endLine: number },
      ) => a.startLine <= b.endLine && b.startLine <= a.endLine;

      if (
        matchingEntities.some(other => other !== entity && overlaps(entity, other)) ||
        (previous && previousRanges.some(other => other !== previous && overlaps(previous, other)))
      ) {
        const warning = `Skipping ambiguous overlapping function ranges: ${entity.id}`;
        diagnostics.push(warning);
        onWarning?.(warning);
        continue;
      }

      const entityChange = extractEntityChange(change, entity, previous);

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
  };
}
