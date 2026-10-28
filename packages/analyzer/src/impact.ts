import * as ts from 'typescript';
import { collectEntities } from './entity-collector';
import {
  extractEntityChange,
  getFunctionRanges,
} from './change-evidence';
import {
  DEFAULT_ENGINE,
  MAX_AFFECTED_ENTITIES,
  MAX_BLAST_DEPTH,
  MAX_SHORTEST_PATH_COUNT,
  STEP_TYPE_PRECEDENCE,
  type EngineProfile,
  type ChangedEntity,
  type EntityChange,
  type EntityCoordinates,
  type ChangedFile,
  type DiagnosticItem,
  type FunctionRange,
  type Entity,
  type EntityImpact,
  type ImpactPath,
  type Relation,
  type RelationType,
} from './contracts';
import { baseToHeadId, correspond, type Correspondence, type FingerprintedEntity } from './correspondence';
import { compareStrings } from './deterministic';
import type { ExtractedGraph } from './technical-graph';

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

function getStepType(calleeId: string, callerId: string, reverseAdjacency: Map<string, Relation[]>): RelationType {
  const types = new Set((reverseAdjacency.get(calleeId) ?? []).filter(relation => relation.from === callerId).map(relation => relation.type));
  return STEP_TYPE_PRECEDENCE.find(type => types.has(type))!;
}

const byId = (left: Entity, right: Entity): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Extended engine: one shortest path per affected entity instead of every simple path.
 * Levels are expanded in ID order and each entity's parent is its smallest-ID predecessor
 * at the previous depth, so output does not depend on relation order. Output is capped at
 * `maxAffected` entities, keeping the shallowest and then lowest-ID ones.
 */
export function getBlastRadiusShortestPaths(
  entityId: string,
  reverseAdjacency: Map<string, Relation[]>,
  entityById: Map<string, Entity>,
  maxDepth: number = MAX_BLAST_DEPTH,
  maxAffected: number = MAX_AFFECTED_ENTITIES,
): { paths: ImpactPath[]; truncated: boolean } {
  const start = entityById.get(entityId);
  if (!start) {
    return { paths: [], truncated: false };
  }

  const depthById = new Map<string, number>([[start.id, 0]]);
  const levels: Entity[][] = [[start]];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = new Map<string, Entity>();
    for (const node of levels[depth]) {
      for (const caller of getCallers(node.id, reverseAdjacency, entityById)) {
        if (!depthById.has(caller.id)) next.set(caller.id, caller);
      }
    }
    if (next.size === 0) break;
    const level = [...next.values()].sort(byId);
    for (const entity of level) depthById.set(entity.id, depth + 1);
    levels.push(level);
  }

  // Keep the shallowest entities first; the cut level is already in ID order.
  const kept: Entity[][] = [];
  let remaining = maxAffected;
  let truncated = false;
  for (const level of levels.slice(1)) {
    if (level.length <= remaining) {
      kept.push(level);
      remaining -= level.length;
    } else {
      kept.push(level.slice(0, remaining));
      truncated = true;
      break;
    }
  }
  const keptTargets = kept.flat();

  // Shortest-path predecessors: u precedes c when c calls u (c is a caller of u) and depth(c) = depth(u) + 1.
  const predecessors = new Map<string, Entity[]>();
  for (const level of levels) {
    for (const node of level) {
      for (const caller of getCallers(node.id, reverseAdjacency, entityById)) {
        if (depthById.get(caller.id) !== depthById.get(node.id)! + 1) continue;
        const list = predecessors.get(caller.id) ?? [];
        list.push(node);
        predecessors.set(caller.id, list);
      }
    }
  }

  const pathCount = new Map<string, number>([[start.id, 1]]);
  const parent = new Map<string, Entity>();
  for (const target of keptTargets) {
    const preds = [...(predecessors.get(target.id) ?? [])].sort(byId);
    parent.set(target.id, preds[0]);
    const count = preds.reduce((sum, pred) => sum + (pathCount.get(pred.id) ?? 0), 0);
    pathCount.set(target.id, Math.min(count, MAX_SHORTEST_PATH_COUNT));
  }

  const paths: ImpactPath[] = keptTargets.map(target => {
    const chain: Entity[] = [target];
    for (let current = parent.get(target.id); current; current = parent.get(current.id)) {
      chain.push(current);
    }
    chain.reverse();
    return {
      target,
      depth: chain.length - 1,
      path: chain,
      pathCount: pathCount.get(target.id)!,
      stepTypes: chain.slice(1).map((caller, i) => getStepType(chain[i].id, caller.id, reverseAdjacency)),
    };
  });

  return { paths, truncated };
}

export function buildImpact(
  changedEntity: ChangedEntity,
  reverseAdjacency: Map<string, Relation[]>,
  entityById: Map<string, Entity>,
  maxDepth: number = MAX_BLAST_DEPTH,
  engine: EngineProfile = DEFAULT_ENGINE,
  maxAffectedEntities: number = MAX_AFFECTED_ENTITIES,
): EntityImpact {
  const extended = engine === 'extended';
  const search = extended
    ? getBlastRadiusShortestPaths(changedEntity.entity.id, reverseAdjacency, entityById, maxDepth, maxAffectedEntities)
    : { paths: getBlastRadiusPaths(changedEntity.entity.id, reverseAdjacency, entityById, maxDepth), truncated: false };
  const paths = search.paths;

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
      ...(extended ? { truncated: search.truncated } : {}),
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

/** Entities and relations of one snapshot, as needed to compare the base graph with the head graph. */
export type GraphView = Pick<ExtractedGraph, 'entities' | 'relations' | 'parentById' | 'entityById' | 'reverseAdjacency'>;

const relationKey = (relation: Relation): string => `${relation.from}|${relation.type}|${relation.to}`;

export const entityCoordinates = ({ id, file, startLine, endLine }: Entity): EntityCoordinates => ({ id, file, startLine, endLine });

/**
 * Pairs base and head entities of the changed files only. Entities without a fingerprint never pair by
 * fingerprint, so they stay deleted + added. Returned entities are the graph's own objects.
 */
export function correspondChangedFiles(options: {
  changedFiles: ChangedFile[];
  head: GraphView;
  base: GraphView;
  headFingerprints: Map<string, string>;
  baseFingerprints: Map<string, string>;
}): Correspondence {
  const { changedFiles, head, base, headFingerprints, baseFingerprints } = options;
  const headFiles = new Set(changedFiles.map(change => change.file));
  const baseFiles = new Set(changedFiles.flatMap(change => change.oldFile ? [change.oldFile] : []));
  const prepare = (graph: GraphView, files: Set<string>, fingerprints: Map<string, string>, side: string): FingerprintedEntity[] =>
    graph.entities.filter(entity => files.has(entity.file))
      .map(entity => ({ ...entity, fp: fingerprints.get(entity.id) ?? `\0${side}:${entity.id}` }));
  const result = correspond(prepare(base, baseFiles, baseFingerprints, 'base'), prepare(head, headFiles, headFingerprints, 'head'));
  const baseOf = (entity: Entity): Entity => base.entityById.get(entity.id) ?? entity;
  const headOf = (entity: Entity): Entity => head.entityById.get(entity.id) ?? entity;
  const pairs = (list: Correspondence['matched']) => list.map(pair => ({ base: baseOf(pair.base), head: headOf(pair.head) }));
  return {
    matched: pairs(result.matched), renamed: pairs(result.renamed), moved: pairs(result.moved),
    added: result.added.map(headOf), deleted: result.deleted.map(baseOf),
    ambiguous: result.ambiguous.map(group => ({ fp: group.fp, base: group.base.map(baseOf), head: group.head.map(headOf) })),
  };
}

function outgoingByEntity(relations: Relation[]): Map<string, Relation[]> {
  const outgoing = new Map<string, Relation[]>();
  for (const relation of relations) {
    const list = outgoing.get(relation.from) ?? [];
    list.push(relation);
    outgoing.set(relation.from, list);
  }
  return outgoing;
}

const sortedRelations = (relations: Map<string, Relation>): Relation[] =>
  [...relations].sort(([a], [b]) => compareStrings(a, b)).map(([, relation]) => relation);

/** Base ids go through the correspondence before the set difference, so a rename alone is not an edge change (D8). */
function edgeDeltas(
  headOut: Relation[], baseOut: Relation[], toHead: Map<string, string>,
): ChangedEntity['edgeDeltas'] {
  const current = new Map(headOut.map(relation => [relationKey(relation), relation]));
  const previous = new Map<string, Relation>();
  for (const relation of baseOut) {
    const mapped: Relation = { from: toHead.get(relation.from) ?? relation.from, to: toHead.get(relation.to) ?? relation.to, type: relation.type };
    previous.set(relationKey(mapped), mapped);
  }
  const added = sortedRelations(new Map([...current].filter(([key]) => !previous.has(key))));
  const removed = sortedRelations(new Map([...previous].filter(([key]) => !current.has(key))));
  return added.length || removed.length ? { added, removed } : undefined;
}

/** A deleted entity's change is its removed lines, in base line numbers (it has no head location). */
function deletedEntityChange(entity: Entity, base: GraphView, changedFiles: ChangedFile[]): EntityChange {
  const file = changedFiles.find(change => (change.oldFile ?? change.file) === entity.file);
  const children = base.entities.filter(other => base.parentById.get(other.id) === entity.id);
  const own = (line: number) => line >= entity.startLine && line <= entity.endLine &&
    !children.some(child => line >= child.startLine && line <= child.endLine);
  const change = file && extractEntityChange(file, { name: entity.name, startLine: 0, endLine: -1 },
    { name: entity.name, startLine: entity.startLine, endLine: entity.endLine }, { current: [], previous: children });
  const changedLines = new Set<number>();
  for (const line of file?.hunks.flatMap(hunk => hunk.lines) ?? []) {
    if (line.kind === '-' && own(line.oldLine)) changedLines.add(line.oldLine);
  }
  return {
    file: entity.file,
    changedLines: [...changedLines].sort((a, b) => a - b),
    addedCode: [],
    removedCode: change?.removedCode ?? [],
    diff: change?.diff ?? `--- a/${entity.file}\n+++ /dev/null`,
  };
}

/**
 * Head changed entities gain changeKind/baseEntity/edgeDeltas; base-only entities become 'deleted' changes
 * appended in id order. Extended engine only.
 */
export function applyCorrespondence(options: {
  changedEntities: ChangedEntity[];
  changedFiles: ChangedFile[];
  head: GraphView;
  base: GraphView;
  correspondence: Correspondence;
}): ChangedEntity[] {
  const { changedEntities, changedFiles, head, base, correspondence } = options;
  const toHead = baseToHeadId(correspondence);
  const headOut = outgoingByEntity(head.relations);
  const baseOut = outgoingByEntity(base.relations);
  const counterpart = new Map<string, { base: Entity; kind: 'modified' | 'renamed' }>();
  for (const pair of correspondence.matched) counterpart.set(pair.head.id, { base: pair.base, kind: 'modified' });
  for (const pair of [...correspondence.renamed, ...correspondence.moved]) counterpart.set(pair.head.id, { base: pair.base, kind: 'renamed' });

  const annotated = changedEntities.map((changed): ChangedEntity => {
    const pair = counterpart.get(changed.entity.id);
    if (!pair) return { ...changed, changeKind: 'added' };
    const deltas = edgeDeltas(headOut.get(changed.entity.id) ?? [], baseOut.get(pair.base.id) ?? [], toHead);
    return {
      ...changed,
      changeKind: pair.kind,
      ...(pair.kind === 'renamed' ? { baseEntity: entityCoordinates(pair.base) } : {}),
      ...(deltas ? { edgeDeltas: deltas } : {}),
    };
  });
  const deleted = correspondence.deleted.map((entity): ChangedEntity => {
    const removed = sortedRelations(new Map((baseOut.get(entity.id) ?? []).map(relation => [relationKey(relation), relation])));
    return {
      entity,
      change: deletedEntityChange(entity, base, changedFiles),
      changeKind: 'deleted',
      baseEntity: entityCoordinates(entity),
      ...(removed.length ? { edgeDeltas: { added: [], removed } } : {}),
    };
  });
  return [...annotated, ...deleted];
}

/** D7: callers of a deleted entity as they were in the base graph; entities that survive are reported as their head versions. */
export function buildDeletedImpact(
  changed: ChangedEntity,
  base: GraphView,
  head: GraphView,
  toHead: Map<string, string>,
  maxAffectedEntities: number,
): EntityImpact {
  const impact = buildImpact(changed, base.reverseAdjacency, base.entityById, undefined, 'extended', maxAffectedEntities);
  const current = (entity: Entity): Entity => head.entityById.get(toHead.get(entity.id) ?? entity.id) ?? entity;
  return {
    ...impact,
    directDependents: impact.directDependents.map(current),
    blastRadius: {
      ...impact.blastRadius,
      entities: impact.blastRadius.entities.map(current),
      paths: impact.blastRadius.paths.map(path => ({ ...path, target: current(path.target), path: path.path.map(current) })),
    },
    terminalDependents: impact.terminalDependents.map(current),
  };
}
