import type { Entity, Relation, RelationType } from './contracts';
import { MAX_SURFACE_REACH_DEPTH, type ApplicationMap, type Surface } from './application-map';

/**
 * R-1: one read-only index over a technical graph (and, when given, its application map), built once per run.
 * Code lookup, the surface lookup, the context pack and the R-10 cluster grouping read from it instead of
 * each rebuilding its own maps. Lists keep the input order, so outputs built from the index match the old
 * per-caller maps byte for byte.
 */
export interface GraphIndex {
  /** The application map the index was built with, if any. */
  readonly applicationMap: Pick<ApplicationMap, 'surfaces' | 'relations'> | undefined;
  entity(id: string): Entity | undefined;
  /** Entities defined in a file, by start line (stable for equal lines). */
  entitiesInFile(file: string): readonly Entity[];
  /** Files that define at least one entity, in the order the graph first lists them. */
  files(): readonly string[];
  /** Graph relations whose `from` is `id`, in input order; filtered to `types` when given. */
  outgoing(id: string, types?: readonly RelationType[]): readonly Relation[];
  /** Graph relations whose `to` is `id`, in input order; filtered to `types` when given. */
  incoming(id: string, types?: readonly RelationType[]): readonly Relation[];
  /** Number of distinct entities with a graph relation to `id`, of any type. */
  callerCount(id: string): number;
  /**
   * Who consumes a group of entities: each entity with a graph relation into the group, mapped to the group
   * members it reaches (in the order `ids` gives them). Keys are sorted by ID, so the same input gives the same map.
   */
  consumers(ids: Iterable<string>, options?: ConsumerOptions): ReadonlyMap<string, readonly string[]>;
  surface(id: string): Surface | undefined;
  /** Surfaces whose entry entities include `id`, in map order. */
  surfacesEnteredAt(id: string): readonly Surface[];
  /** Surfaces whose component/handler tree can reach the entity, nearest first (graph and map relations). */
  surfacesForEntity(entityId: string, limit?: number): Array<{ surface: Surface; path: string[] }>;
}

export interface ConsumerOptions {
  types?: readonly RelationType[];
  /** Leave out consumers that are themselves in the group. Default false. */
  excludeMembers?: boolean;
}

export interface GraphIndexInput {
  entities?: readonly Entity[];
  relations: readonly Relation[];
  applicationMap?: Pick<ApplicationMap, 'surfaces' | 'relations'>;
}

const EMPTY: readonly never[] = Object.freeze([]);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildGraphIndex(input: GraphIndexInput): GraphIndex {
  const map = input.applicationMap;
  const byId = new Map<string, Entity>();
  const byFile = new Map<string, Entity[]>();
  for (const entity of input.entities ?? []) {
    byId.set(entity.id, entity);
    push(byFile, entity.file, entity);
  }
  for (const list of byFile.values()) list.sort((a, b) => a.startLine - b.startLine);

  const out = new Map<string, Relation[]>();
  const into = new Map<string, Relation[]>();
  const callerSets = new Map<string, Set<string>>();
  for (const relation of input.relations) {
    push(out, relation.from, relation);
    push(into, relation.to, relation);
    const set = callerSets.get(relation.to);
    if (set) set.add(relation.from);
    else callerSets.set(relation.to, new Set([relation.from]));
  }
  // Surface reach walks graph relations first, then the map's supplemental ones, as findSurfacesForEntity always has.
  const reachInto = new Map<string, string[]>();
  for (const relation of [...input.relations, ...(map?.relations ?? [])]) push(reachInto, relation.to, relation.from);
  const surfaceById = new Map<string, Surface>();
  const entryIndex = new Map<string, Surface[]>();
  for (const surface of map?.surfaces ?? []) {
    surfaceById.set(surface.id, surface);
    for (const id of surface.entryEntityIds) push(entryIndex, id, surface);
  }

  const filter = (list: readonly Relation[] | undefined, types?: readonly RelationType[]) =>
    !list ? EMPTY : types ? list.filter(relation => types.includes(relation.type)) : list;

  return {
    applicationMap: map,
    entity: id => byId.get(id),
    entitiesInFile: file => byFile.get(file) ?? EMPTY,
    files: () => [...byFile.keys()],
    outgoing: (id, types) => filter(out.get(id), types),
    incoming: (id, types) => filter(into.get(id), types),
    callerCount: id => callerSets.get(id)?.size ?? 0,
    consumers(ids, options = {}) {
      const group = [...new Set(ids)];
      const members = new Set(group);
      const found = new Map<string, string[]>();
      for (const id of group) {
        for (const relation of filter(into.get(id), options.types)) {
          if (options.excludeMembers && members.has(relation.from)) continue;
          const list = found.get(relation.from);
          if (!list) found.set(relation.from, [id]);
          else if (list[list.length - 1] !== id) list.push(id);
        }
      }
      return new Map([...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
    surface: id => surfaceById.get(id),
    surfacesEnteredAt: id => entryIndex.get(id) ?? EMPTY,
    surfacesForEntity(entityId, limit = 8) {
      // Reverse BFS from the entity; any reached entity that is a surface entry maps to that surface.
      const next = new Map<string, string | null>([[entityId, null]]);
      let frontier = [entityId];
      const found: Array<{ surface: Surface; path: string[] }> = [];
      const seenSurfaces = new Set<string>();
      for (let depth = 0; depth <= MAX_SURFACE_REACH_DEPTH && frontier.length && found.length < limit; depth += 1) {
        const upcoming: string[] = [];
        for (const id of frontier) {
          for (const surface of entryIndex.get(id) ?? []) {
            if (seenSurfaces.has(surface.id)) continue;
            seenSurfaces.add(surface.id);
            const path: string[] = [];
            for (let current: string | null | undefined = id; current; current = next.get(current)) path.push(current);
            found.push({ surface, path });
          }
          for (const caller of reachInto.get(id) ?? []) if (!next.has(caller)) { next.set(caller, id); upcoming.push(caller); }
        }
        frontier = upcoming;
      }
      return found.slice(0, limit);
    },
  };
}
