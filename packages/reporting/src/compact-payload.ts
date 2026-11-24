import type { buildLLMPayload } from './qa-evidence';

/**
 * R-2: lossless compact encoding of the report payload.
 *
 * The full payload repeats a whole entity object at every mention (dependents, every path step, the
 * production/test copies) and spells each path out again as `typedPath`. Blast-radius paths alone were
 * 67% of the bytes on corpus-31 (R-0). Here every entity is described once in `entities`, keyed by ID,
 * and everything else refers to it by ID.
 *
 * Fields that the analyzer's invariants make redundant are left out only when the invariant holds for
 * that item, so the encoding stays lossless for any input (see `expandCompactPayload`):
 * - a path's first step (the changed entity), its `target` (the last step) and its `depth` (its length);
 * - `blastRadius.entities`, when it equals the path targets in order;
 * - `productionDependents` / `testDependents`, which filter `blastRadius.entities` by the role in `entities`;
 * - an entity's file and name, when its ID is `file#name` (optionally with a `~N` suffix).
 */

type FullPayload = ReturnType<typeof buildLLMPayload>;
type PayloadEntity = FullPayload['changes'][number]['changedEntity'];
type FullChange = FullPayload['changes'][number];
type FullPath = FullChange['blastRadius']['paths'][number];

/** How the report model reads the compact form; part of the system instruction, so payloads don't repeat it. */
export const compactEncodingInstruction = `
The evidence is compact. entities maps each entity ID to "startLine-endLine kind sourceRole", plus "exported" when the
entity is exported, "as=<name>" for a different export name, "in=<container>" for an unusual container ("in=-" for none), and a language
when it is not TypeScript. An ID is file#name (a ~2 suffix tells same-named entities apart); an entity whose ID does not
follow that rule is an object with its file and name. Everything else names entities by ID.
In each change, blastRadius.paths lists how the change reaches each affected entity. A path is the list of entity IDs
after the changed entity: path[0] depends directly on the changed entity and the last ID is the affected target.
stepTypes[i] is how path[i] depends on the step before it (the changed entity for i = 0): CALLS = called by,
RENDERS = rendered by (a component shows it in its JSX), INSTANTIATES = constructed by (new), REFERENCES = referenced by
(passed or stored as a value, for example as a callback or event handler). Use these to explain why a page or component
is affected, for example that a changed row component appears inside a list that a page renders.
Production and test dependents are the affected entities whose sourceRole says so.
confidence "likely" marks a path or change that rests on at least one inferred edge; truncated means the blast radius was cut,
and totalAffectedEntities still gives the full count; hubs are widely used entities the traversal did not expand past.
`.trim();

const SIMPLE = /^\S+$/;
/** `App.render` is a member of `App`; a name without a dot has no container. */
const impliedContainer = (name: string) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : undefined);

/** One entity's table entry: a short string, or an object when the ID does not carry its file and name. */
function describe(entity: PayloadEntity): string | Record<string, unknown> {
  const { id, kind, name, file, startLine, endLine, language, container, exported, exportName, sourceRole } = entity;
  const parts = [`${startLine}-${endLine}`, kind, sourceRole];
  if (exported) parts.push('exported');
  if (exportName !== undefined && exportName !== name) parts.push(`as=${exportName}`);
  if (container !== impliedContainer(name)) parts.push(`in=${container ?? '-'}`);
  if (language !== undefined && language !== 'typescript') parts.push(language);
  const derivable = id.replace(/~\d+$/, '') === `${file}#${name}`;
  if (derivable && parts.every(part => SIMPLE.test(part))) return parts.join(' ');
  return { file, name, lines: `${startLine}-${endLine}`, kind, sourceRole,
    ...(exported ? { exported } : {}), ...(exportName !== undefined ? { exportName } : {}),
    ...(container !== undefined ? { container } : {}), ...(language !== undefined ? { language } : {}) };
}

function compactPath(path: FullPath, changedId: string, ref: (entity: PayloadEntity) => string) {
  const { target, depth, path: steps, typedPath: _typedPath, ...rest } = path as FullPath & { typedPath?: string };
  const ids = steps.map(ref);
  const startsAtChange = ids[0] === changedId;
  const tail = startsAtChange ? ids.slice(1) : ids;
  const targetId = ref(target);
  return {
    path: tail,
    ...(startsAtChange ? {} : { fromStart: true }),
    ...(ids.at(-1) === targetId ? {} : { target: targetId }),
    ...(depth === ids.length - 1 ? {} : { depth }),
    ...rest,
  };
}

/** The compact report payload. Deterministic: the same full payload gives the same bytes. */
export function compactLLMPayload(payload: FullPayload) {
  const entities: Record<string, string | Record<string, unknown>> = {};
  const ref = (entity: PayloadEntity) => { entities[entity.id] ??= describe(entity); return entity.id; };
  const changes = payload.changes.map(change => {
    const changedId = ref(change.changedEntity);
    const { totalAffectedEntities, entities: affected, paths, ...radiusRest } = change.blastRadius;
    const compactPaths = paths.map(path => compactPath(path, changedId, ref));
    const affectedIds = affected.map(ref);
    const targets = paths.map(path => path.target.id);
    const sameAsTargets = affectedIds.length === targets.length && affectedIds.every((id, i) => id === targets[i]);
    const { changedEntity: _c, change: code, directDependents, blastRadius: _b, productionDependents: _p, testDependents: _t, terminalDependents, ...changeRest } = change;
    return {
      changedEntity: changedId,
      ...changeRest,
      change: code,
      directDependents: directDependents.map(ref),
      blastRadius: { totalAffectedEntities, ...radiusRest, ...(sameAsTargets ? {} : { entities: affectedIds }), paths: compactPaths },
      terminalDependents: terminalDependents.map(ref),
    };
  });
  return { analysisScope: payload.analysisScope, entities, changes, applicationContext: payload.applicationContext, limitations: payload.limitations };
}

export type CompactLLMPayload = ReturnType<typeof compactLLMPayload>;

/**
 * Inverse of `compactLLMPayload`, for tests: rebuilds every entity, path and step type. `typedPath` is not rebuilt
 * (it restates `path` and `stepTypes`), and an entity with no language comes back as TypeScript.
 */
export function expandCompactPayload(compact: CompactLLMPayload) {
  const entity = (id: string) => {
    const value = compact.entities[id];
    if (value === undefined) throw new Error(`entity ${id} is not in the table`);
    if (typeof value === 'object') {
      const { lines, ...fields } = value as { lines: string } & Record<string, unknown>;
      const [startLine, endLine] = lines.split('-').map(Number);
      return { id, ...fields, startLine, endLine } as Record<string, unknown>;
    }
    const [lines, kind, sourceRole, ...flags] = value.split(' ');
    const [startLine, endLine] = lines!.split('-').map(Number);
    const base = id.replace(/~\d+$/, '');
    const hash = base.indexOf('#');
    const name = base.slice(hash + 1);
    const out: Record<string, unknown> = { id, kind, name, file: base.slice(0, hash), startLine, endLine, sourceRole, language: 'typescript' };
    if (impliedContainer(name) !== undefined) out.container = impliedContainer(name);
    for (const flag of flags) {
      if (flag === 'exported') out.exported = true;
      else if (flag.startsWith('as=')) out.exportName = flag.slice(3);
      else if (flag === 'in=-') delete out.container;
      else if (flag.startsWith('in=')) out.container = flag.slice(3);
      else out.language = flag;
    }
    return out;
  };
  return {
    analysisScope: compact.analysisScope,
    changes: compact.changes.map(change => {
      const { changedEntity, change: code, directDependents, blastRadius, terminalDependents, ...rest } = change;
      const { totalAffectedEntities, paths, entities: listed, ...radiusRest } = blastRadius as typeof blastRadius & { entities?: string[] };
      const fullPaths = paths.map(p => {
        const { path, fromStart, target, depth, ...pathRest } = p as typeof p & { fromStart?: boolean; target?: string; depth?: number };
        const ids = fromStart ? path : [changedEntity, ...path];
        return { target: entity(target ?? ids.at(-1)!), depth: depth ?? ids.length - 1, path: ids.map(entity), ...pathRest };
      });
      const affected = (listed ?? fullPaths.map(p => (p.target as { id: string }).id)).map(entity);
      return {
        changedEntity: entity(changedEntity), ...rest, change: code,
        directDependents: directDependents.map(entity),
        blastRadius: { totalAffectedEntities, ...radiusRest, entities: affected, paths: fullPaths },
        productionDependents: affected.filter(e => e.sourceRole === 'production'),
        testDependents: affected.filter(e => e.sourceRole === 'test'),
        terminalDependents: terminalDependents.map(entity),
      };
    }),
    applicationContext: compact.applicationContext,
    limitations: compact.limitations,
  };
}
