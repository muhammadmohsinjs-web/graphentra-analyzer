import type { Entity, EntityImpact } from '@graphentra/analyzer';
import { getSourceRole } from './qa-evidence';

/**
 * R-3: last-resort ranked trimming, for when one report call (the whole change, or one R-10 group) is still too big for
 * the model.
 *
 * The budget is a share of the model's context window, not a fixed character count. Only indirect dependents can be cut:
 * changed code, diffs, totals (`totalAffectedEntities`) and direct dependents always stay. The cut order puts the least
 * useful first: test code, then dependents reached through an inferred ("likely") edge, then the deepest, so the code
 * nearest the change is kept longest. Every entity that no longer appears anywhere in the evidence is returned, so the
 * report can list it under "Not covered". The same input always gives the same cuts.
 */
export interface PayloadBudget {
  /** The report model's context window in tokens. Default 1,000,000, for the default report model (see below). */
  contextTokens?: number;
  /** Share of the window the evidence may use; the rest is the instruction, related code and the answer. Default 0.8. */
  share?: number;
  /** Bytes per token for the compact JSON evidence. Default 4 (measured about 4.3). */
  bytesPerToken?: number;
}

/*
 * Defaults are calibrated on the default report model (Luna) from past eval runs, so trimming never touches a call that
 * worked: r11-excalidraw-08 sent 546k tokens and got a valid report, r11-excalidraw-22 (about twice that) failed, and
 * 223 single calls over 192 KB were valid. 1M x 0.8 x 4 bytes = 3.2 MB of compact evidence (about 750k tokens).
 * A model with a smaller window must pass its own `contextTokens` (GLM's largest valid call was about 175k tokens).
 */
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
export const DEFAULT_BUDGET_SHARE = 0.8;
export const DEFAULT_BYTES_PER_TOKEN = 4;

/** The evidence byte budget for one call. */
export function budgetBytes(budget: PayloadBudget = {}): number {
  return Math.floor((budget.contextTokens ?? DEFAULT_CONTEXT_TOKENS) * (budget.share ?? DEFAULT_BUDGET_SHARE)
    * (budget.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN));
}

export interface TrimResult {
  impacts: EntityImpact[];
  /** Entities that no longer appear anywhere in the trimmed impacts, sorted by id. */
  cut: Entity[];
  /** Number of (change, dependent) listings removed. */
  removed: number;
  /** False when even cutting every candidate leaves the evidence over budget. */
  fits: boolean;
  bytes: number;
}

interface Candidate { impact: number; entity: Entity; rank: [number, number, number, string] }

const compare = (left: Candidate, right: Candidate): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.rank[index] as number) - (right.rank[index] as number);
    if (difference !== 0) return difference;
  }
  if (left.rank[3] !== right.rank[3]) return left.rank[3] < right.rank[3] ? -1 : 1;
  return left.impact - right.impact;
};

/** Cut candidates in cut order: test first, then inferred, then deepest; ties by entity id, then change. */
function candidates(impacts: readonly EntityImpact[]): Candidate[] {
  const list: Candidate[] = [];
  impacts.forEach((impact, index) => {
    const direct = new Set(impact.directDependents.map(entity => entity.id));
    const pathOf = new Map(impact.blastRadius.paths.map(path => [path.target.id, path]));
    for (const entity of impact.blastRadius.entities) {
      if (direct.has(entity.id) || entity.id === impact.changedEntity.id) continue;
      const path = pathOf.get(entity.id);
      list.push({ impact: index, entity, rank: [
        getSourceRole(entity.file) === 'test' ? 0 : 1,
        path?.confidence === 'likely' ? 0 : 1,
        -(path?.depth ?? Number.MAX_SAFE_INTEGER),
        entity.id,
      ] });
    }
  });
  return list.sort(compare);
}

function apply(impacts: readonly EntityImpact[], cut: readonly Candidate[]): EntityImpact[] {
  const byImpact = new Map<number, Set<string>>();
  for (const candidate of cut) {
    const set = byImpact.get(candidate.impact) ?? new Set<string>();
    set.add(candidate.entity.id);
    byImpact.set(candidate.impact, set);
  }
  return impacts.map((impact, index) => {
    const removed = byImpact.get(index);
    if (!removed) return impact;
    const keep = (entity: Entity) => !removed.has(entity.id);
    return {
      ...impact,
      blastRadius: {
        ...impact.blastRadius,
        entities: impact.blastRadius.entities.filter(keep),
        paths: impact.blastRadius.paths.filter(path => keep(path.target)),
        truncated: true,
      },
      terminalDependents: impact.terminalDependents.filter(keep),
    };
  });
}

/** Every entity the impacts still mention. */
export function mentionedEntities(impacts: readonly EntityImpact[]): Set<string> {
  const ids = new Set<string>();
  for (const impact of impacts) {
    ids.add(impact.changedEntity.id);
    for (const entity of [...impact.directDependents, ...impact.blastRadius.entities, ...impact.terminalDependents]) ids.add(entity.id);
    for (const path of impact.blastRadius.paths) for (const step of path.path) ids.add(step.id);
    for (const target of impact.receivesChangedValue ?? []) ids.add(target.entity.id);
  }
  return ids;
}

/**
 * Removes the fewest ranked dependents that bring `size(impacts)` within `maxBytes`. `size` measures what is actually
 * sent (the compact payload built from the impacts). Impacts already within budget come back unchanged.
 */
export function trimImpacts(impacts: EntityImpact[], size: (impacts: EntityImpact[]) => number, maxBytes: number): TrimResult {
  const initial = size(impacts);
  if (initial <= maxBytes) return { impacts, cut: [], removed: 0, fits: true, bytes: initial };
  const order = candidates(impacts);
  // Cutting more never makes the payload bigger, so binary-search the fewest cuts that fit.
  let low = 1;
  let high = order.length;
  let best: { impacts: EntityImpact[]; bytes: number } | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const trimmed = apply(impacts, order.slice(0, middle));
    const bytes = size(trimmed);
    if (bytes <= maxBytes) { best = { impacts: trimmed, bytes }; high = middle - 1; } else low = middle + 1;
  }
  const fits = best !== undefined;
  const removed = fits ? high + 1 : order.length;
  const result = best ?? (() => { const all = apply(impacts, order); return { impacts: all, bytes: size(all) }; })();
  const still = mentionedEntities(result.impacts);
  const cut = new Map<string, Entity>();
  for (const candidate of order.slice(0, removed)) if (!still.has(candidate.entity.id)) cut.set(candidate.entity.id, candidate.entity);
  return {
    impacts: result.impacts,
    cut: [...cut.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    removed,
    fits,
    bytes: result.bytes,
  };
}
