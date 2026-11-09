import { MAX_SURFACE_REACH_DEPTH } from './application-map';
import type { AffectedSurface, EdgeConfidence, EntityImpact, Relation, SurfaceEdge } from './contracts';
import { compareStrings } from './deterministic';

export { MAX_SURFACE_REACH_DEPTH } from './application-map';

export interface SurfaceReachInput {
  /** Entity relations of the head graph (from depends on to). */
  relations: readonly Relation[];
  /** SURFACE_HANDLED_BY (surface → entity) and CALLS_ENDPOINT (entity → api surface); TEST_COVERS is ignored. */
  surfaceEdges: readonly SurfaceEdge[];
  /** Ids of the surfaces that can be reported. */
  surfaceIds: Iterable<string>;
  /** Depth limit in edges (default MAX_SURFACE_REACH_DEPTH). */
  maxDepth?: number;
}

const weaker = (a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence => (a === 'likely' || b === 'likely' ? 'likely' : 'proven');

/**
 * D7: one reverse BFS over the union graph. Every edge points from the dependent to what it depends on
 * (entity → entity, surface → handler, calling entity → api surface), so a change flows against the edge
 * direction. Returns a function giving the surfaces reached from a changed entity: shortest path first; among
 * equally short paths a proven one wins over a likely one, then the first in sorted discovery order.
 */
export function createSurfaceReach(input: SurfaceReachInput): (entityId: string) => AffectedSurface[] {
  const maxDepth = input.maxDepth ?? MAX_SURFACE_REACH_DEPTH;
  const surfaceIds = new Set(input.surfaceIds);
  // reverse.get(x) = dependents of x with the strongest confidence seen for that edge.
  const reverse = new Map<string, Map<string, EdgeConfidence>>();
  const add = (from: string, to: string, confidence: EdgeConfidence) => {
    let dependents = reverse.get(to);
    if (!dependents) reverse.set(to, dependents = new Map());
    const existing = dependents.get(from);
    dependents.set(from, existing === 'proven' || confidence === 'proven' ? 'proven' : 'likely');
  };
  for (const relation of input.relations) add(relation.from, relation.to, relation.confidence ?? 'proven');
  for (const edge of input.surfaceEdges) {
    if (edge.type === 'SURFACE_HANDLED_BY' || edge.type === 'CALLS_ENDPOINT') add(edge.from, edge.to, edge.confidence);
  }
  const sortedDependents = new Map<string, Array<[string, EdgeConfidence]>>();
  for (const [to, dependents] of reverse) sortedDependents.set(to, [...dependents].sort((a, b) => compareStrings(a[0], b[0])));

  return (entityId: string): AffectedSurface[] => {
    const state = new Map<string, { depth: number; confidence: EdgeConfidence; previous: string | null }>();
    state.set(entityId, { depth: 0, confidence: 'proven', previous: null });
    let frontier = [entityId];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const discovered: string[] = [];
      for (const node of frontier) {
        const current = state.get(node)!;
        for (const [dependent, edgeConfidence] of sortedDependents.get(node) ?? []) {
          const confidence = weaker(current.confidence, edgeConfidence);
          const seen = state.get(dependent);
          if (!seen) {
            state.set(dependent, { depth, confidence, previous: node });
            discovered.push(dependent);
          } else if (seen.depth === depth && seen.confidence === 'likely' && confidence === 'proven') {
            state.set(dependent, { depth, confidence, previous: node });
          }
        }
      }
      frontier = discovered.sort(compareStrings);
    }
    const affected: AffectedSurface[] = [];
    for (const [id, { depth, confidence }] of state) {
      if (!surfaceIds.has(id) || id === entityId) continue;
      const path: string[] = [];
      for (let current: string | null = id; current !== null; current = state.get(current)!.previous) path.unshift(current);
      affected.push({ surfaceId: id, depth, path, confidence });
    }
    return affected.sort((a, b) => a.depth - b.depth || compareStrings(a.surfaceId, b.surfaceId));
  };
}

/** Surfaces reachable from one changed entity (D7), sorted by depth then surfaceId. */
export function computeAffectedSurfaces(input: SurfaceReachInput & { entityId: string }): AffectedSurface[] {
  return createSurfaceReach(input)(input.entityId);
}

/** Adds `affectedSurfaces` to each impact; the field stays absent when nothing is reached. */
export function withAffectedSurfaces(impacts: EntityImpact[], input: SurfaceReachInput): EntityImpact[] {
  const reach = createSurfaceReach(input);
  return impacts.map(impact => {
    const affectedSurfaces = reach(impact.changedEntity.id);
    return affectedSurfaces.length > 0 ? { ...impact, affectedSurfaces } : impact;
  });
}
