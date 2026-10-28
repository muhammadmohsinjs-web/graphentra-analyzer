import type { Entity } from './contracts';
import { compareStrings } from './deterministic';

/** fp is the normalized body with parameters renamed; computed by the caller. */
export interface FingerprintedEntity extends Entity { fp: string }

export interface EntityPair { base: Entity; head: Entity }

export interface Correspondence {
  matched: EntityPair[];
  renamed: EntityPair[];
  moved: EntityPair[];
  /** Head-only, including the head side of ambiguous groups. */
  added: Entity[];
  /** Base-only, including the base side of ambiguous groups. */
  deleted: Entity[];
  ambiguous: Array<{ fp: string; base: Entity[]; head: Entity[] }>;
}

const byId = (a: Entity, b: Entity): number => compareStrings(a.id, b.id);
const byBaseId = (a: EntityPair, b: EntityPair): number => compareStrings(a.base.id, b.base.id);

/**
 * Conservative base-to-head pairing: same id first, then a rename/move only when exactly one base and one
 * head entity share kind and fingerprint. Any collision is ambiguous and stays deleted + added.
 */
export function correspond(base: FingerprintedEntity[], head: FingerprintedEntity[]): Correspondence {
  const headById = new Map(head.map((entity) => [entity.id, entity]));
  const baseIds = new Set(base.map((entity) => entity.id));
  const out: Correspondence = { matched: [], renamed: [], moved: [], added: [], deleted: [], ambiguous: [] };

  const groups = new Map<string, { fp: string; base: FingerprintedEntity[]; head: FingerprintedEntity[] }>();
  const group = (entity: FingerprintedEntity) => {
    const key = `${entity.kind}\0${entity.fp}`;
    let found = groups.get(key);
    if (!found) groups.set(key, found = { fp: entity.fp, base: [], head: [] });
    return found;
  };

  for (const entity of base) {
    const counterpart = headById.get(entity.id);
    if (counterpart) out.matched.push({ base: entity, head: counterpart });
    else if (entity.kind === 'module') out.deleted.push(entity);
    else group(entity).base.push(entity);
  }
  for (const entity of head) {
    if (baseIds.has(entity.id)) continue;
    if (entity.kind === 'module') out.added.push(entity);
    else group(entity).head.push(entity);
  }

  for (const { fp, base: baseSide, head: headSide } of groups.values()) {
    if (baseSide.length === 1 && headSide.length === 1) {
      const pair = { base: baseSide[0], head: headSide[0] };
      (pair.base.file === pair.head.file ? out.renamed : out.moved).push(pair);
      continue;
    }
    out.deleted.push(...baseSide);
    out.added.push(...headSide);
    if (baseSide.length && headSide.length) {
      out.ambiguous.push({ fp, base: [...baseSide].sort(byId), head: [...headSide].sort(byId) });
    }
  }

  out.matched.sort(byBaseId);
  out.renamed.sort(byBaseId);
  out.moved.sort(byBaseId);
  out.added.sort(byId);
  out.deleted.sort(byId);
  out.ambiguous.sort((a, b) => compareStrings(a.fp, b.fp) || compareStrings(a.base[0].id, b.base[0].id));
  return out;
}

/** Base entity id to head entity id for every surviving entity (matched, renamed, moved). */
export function baseToHeadId(c: Correspondence): Map<string, string> {
  return new Map([...c.matched, ...c.renamed, ...c.moved].sort(byBaseId).map(({ base, head }) => [base.id, head.id]));
}
