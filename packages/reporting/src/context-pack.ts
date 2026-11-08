import {
  findSurfacesForEntity, type ApplicationMap, type EntityImpact, type Relation, type Surface,
} from '@graphentra/analyzer';
import type { ApplicationContextV2, EntityAnnotationV2 } from './context-contract';

/** Budget for the serialized pack; beyond this, lower-priority detail is dropped and listed in `omitted`. */
const PACK_BUDGET_CHARS = 40_000;
const MAX_AREAS_PER_CHANGE = 6;
const MAX_DEPENDENT_MEANINGS = 12;
const MAX_RULES = 12;
const MAX_VALUE_RECEIVERS = 8;
/** A function with more callers than this is treated as a generic helper when ranking receivers. */
const SPECIFIC_FAN_IN = 5;
const MAX_GLOSSARY = 25;

export type AnnotationVersion = 'current-version' | 'version-before-this-change' | 'possibly-outdated' | 'unknown-version';

export interface AffectedArea {
  surfaceId: string;
  kind: Surface['kind'];
  route: string;
  method?: string;
  businessName?: string;
  purpose?: string;
  feature?: { name: string; criticality: string; reason: string };
  howToReach: string[];
  access: string;
  setup: string[];
  visibleText: string[];
  /** Business meaning of each step between the surface and the changed function. */
  reachedThrough: string[];
  distance: number;
  e2eFlows: Array<{ title: string; steps: string[] }>;
  /** For API endpoints: UI pages in this repository that call it. */
  usedByPages: Array<{ surfaceId: string; businessName?: string; route: string; howToReach: string[] }>;
  basis: 'mapped-from-code' | 'mapped-and-described';
}

export interface ContextPack {
  application: { name: string; summary: string; purpose: string; platform: string; userRoles: Array<{ name: string; description: string }> };
  changes: Array<{
    changedEntityId: string;
    changedBehaviour: (Pick<EntityAnnotationV2, 'businessMeaning' | 'userVisibleEffect' | 'basis' | 'confidence'> & { describes: AnnotationVersion }) | null;
    features: Array<{ id: string; name: string; criticality: string; criticalityReason: string }>;
    affectedAreas: AffectedArea[];
    /** Business role of the changed function's file (file-level contexts). */
    fileRole?: string;
    /** Code the changed value reaches, ranked and capped for the report. evidence.json keeps the full list. */
    receivesChangedValue?: Array<{ entityId: string; receivedThrough: string; meaning?: string; assumptionConflict?: string }>;
    dependentMeanings: Array<{ entityId: string; businessMeaning: string; userVisibleEffect: string }>;
    /** File-level contexts: the role of each file holding dependents that have no annotation of their own. */
    dependentFileRoles: Array<{ file: string; role: string; entityIds: string[] }>;
    rules: Array<{ statement: string; kind: string; basis: string; describes: AnnotationVersion }>;
    openQuestions: string[];
  }>;
  glossary: Array<{ term: string; identifiers: string[]; meaning: string }>;
  /** Annotations for the changed entities and their dependents (kept for compatibility). */
  entityAnnotations: EntityAnnotationV2[];
  unmappedEntityIds: string[];
  /** All surface IDs the report may reference in testAreas[].surfaceIds. */
  allowedSurfaceIds: string[];
  contextStatus: { schemaVersion: '2.0'; migratedFrom?: string; generatedAt: string; coverage: ApplicationContextV2['meta']['coverage']; warnings: string[] };
  omitted: string[];
}

export interface BuildContextPackOptions {
  applicationMap?: ApplicationMap;
  relations?: Relation[];
  warnings?: string[];
}

function splitIdentifier(identifier: string): string {
  return identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

function versionOf(annotation: { fingerprint?: string; entityId: string } | undefined, map: ApplicationMap | undefined, changedIds: Set<string>): AnnotationVersion {
  const current = annotation ? map?.entityFingerprints[annotation.entityId] : undefined;
  if (!annotation?.fingerprint || !current) return 'unknown-version';
  if (annotation.fingerprint === current) return 'current-version';
  return changedIds.has(annotation.entityId) ? 'version-before-this-change' : 'possibly-outdated';
}

function fallbackHowToReach(surface: Surface): string[] {
  if (surface.navigation.length) return surface.navigation;
  return surface.kind === 'ui_route'
    ? [`Open ${surface.route} directly (no in-app link was found in code)`]
    : [`Send ${surface.method ?? 'a request'} ${surface.route}`];
}

function fallbackAccess(surface: Surface): string {
  const hints = surface.access.filter(hint => hint.kind !== 'public').map(hint => hint.kind === 'role' ? `role ${hint.value}` : hint.value);
  if (surface.access.some(hint => hint.kind === 'public')) return 'Public (marked public in code)';
  return hints.length ? `Restricted by ${[...new Set(hints)].join(', ')}` : 'No access restriction found in code';
}

const describeConflict = (characters: string[]): string => {
  const names = characters.length === 1 ? `the ${characters[0]} character` : `the ${characters.slice(0, -1).join(', ')} and ${characters.at(-1)} characters`;
  return `This code splits or searches its input on ${names}, which the changed code now removes before the value reaches it.`;
};

export function buildContextPack(context: ApplicationContextV2, impacts: EntityImpact[], options: BuildContextPackOptions = {}): ContextPack {
  const map = options.applicationMap;
  const relations = options.relations ?? [];
  const omitted: string[] = [];
  const changedIds = new Set(impacts.map(impact => impact.changedEntity.id));
  const annotationById = new Map(context.entityAnnotations.map(annotation => [annotation.entityId, annotation]));
  const featureById = new Map(context.features.map(feature => [feature.id, feature]));
  const describedSurface = new Map(context.surfaces.map(surface => [surface.surfaceId, surface]));
  const surfaceById = new Map((map?.surfaces ?? []).map(surface => [surface.id, surface]));
  const fileRoleOf = new Map((context.fileSummaries ?? []).map(item => [item.file, item.summary]));
  const fanIn = new Map<string, Set<string>>();
  for (const relation of options.relations ?? []) {
    if (!fanIn.has(relation.to)) fanIn.set(relation.to, new Set());
    fanIn.get(relation.to)!.add(relation.from);
  }
  const callersOf = (id: string) => fanIn.get(id)?.size ?? 0;
  // A report reads these, so rank specific code in another file first: it is the likeliest to hold a hidden assumption.
  // A receiver that relies on a character the change removes comes first: it is the strongest lead the analyzer has.
  const receiversOf = (impact: EntityImpact) => [...(impact.receivesChangedValue ?? [])].sort((a, b) =>
    Number(!a.reliesOnRemovedCharacters?.length) - Number(!b.reliesOnRemovedCharacters?.length)
    || Number(callersOf(a.entity.id) > SPECIFIC_FAN_IN) - Number(callersOf(b.entity.id) > SPECIFIC_FAN_IN)
    || Number(a.entity.file === impact.changedEntity.file) - Number(b.entity.file === impact.changedEntity.file)
    || callersOf(a.entity.id) - callersOf(b.entity.id)
    || (a.entity.id < b.entity.id ? -1 : 1)).slice(0, MAX_VALUE_RECEIVERS);
  const entityFile = new Map(impacts.flatMap(impact => [impact.changedEntity, ...impact.blastRadius.entities, ...(impact.receivesChangedValue ?? []).map(target => target.entity)])
    .map(entity => [entity.id, entity.file]));
  const fileOf = (id: string) => entityFile.get(id) ?? id.split('#')[0]!;
  // Functions without their own annotation fall back to their file's role.
  const meaningOf = (id: string) => annotationById.get(id)?.businessMeaning
    ?? (fileRoleOf.has(fileOf(id)) ? `Part of ${fileOf(id)}: ${fileRoleOf.get(fileOf(id))}` : undefined);
  const criticalityRank = { critical: 0, high: 1, normal: 2, low: 3 } as Record<string, number>;

  const relevantIds = new Set(impacts.flatMap(impact => [impact.changedEntity.id, ...impact.blastRadius.entities.map(entity => entity.id), ...receiversOf(impact).map(target => target.entity.id)]));

  const describeArea = (surface: Surface, path: string[]): AffectedArea => {
    const described = describedSurface.get(surface.id);
    const feature = [...(described?.featureIds ?? []), ...context.features.filter(item => item.surfaceIds.includes(surface.id)).map(item => item.id)]
      .map(id => featureById.get(id)).filter(Boolean)
      .sort((a, b) => criticalityRank[a!.criticality]! - criticalityRank[b!.criticality]!)[0];
    const usedByPages = surface.kind === 'api_endpoint' && map
      ? [...new Set(map.requests.filter(request => request.targetSurfaceIds.includes(surface.id)).flatMap(request => request.fromSurfaceIds))]
        .map(id => surfaceById.get(id)).filter((page): page is Surface => Boolean(page)).slice(0, 4)
        .map(page => ({ surfaceId: page.id, businessName: describedSurface.get(page.id)?.businessName, route: page.route,
          howToReach: describedSurface.get(page.id)?.howToReach.length ? describedSurface.get(page.id)!.howToReach : fallbackHowToReach(page) }))
      : [];
    return {
      surfaceId: surface.id, kind: surface.kind, route: surface.route, ...(surface.method ? { method: surface.method } : {}),
      ...(described ? { businessName: described.businessName, purpose: described.purpose } : {}),
      ...(feature ? { feature: { name: feature.name, criticality: feature.criticality, reason: feature.criticalityReason } } : {}),
      howToReach: described?.howToReach.length ? described.howToReach : fallbackHowToReach(surface),
      access: described?.access || fallbackAccess(surface),
      setup: described?.setup ?? [],
      visibleText: surface.uiText.slice(0, 10),
      reachedThrough: path.slice(0, -1).map(id => meaningOf(id) ?? 'an unannotated step').slice(0, 6),
      distance: Math.max(0, path.length - 1),
      e2eFlows: (map?.e2eFlows ?? []).filter(flow => flow.surfaceIds.includes(surface.id)).slice(0, 2)
        .map(flow => ({ title: flow.title, steps: flow.steps.slice(0, 10) })),
      usedByPages,
      basis: described ? 'mapped-and-described' : 'mapped-from-code',
    };
  };

  const changes: ContextPack['changes'] = impacts.map(impact => {
    const id = impact.changedEntity.id;
    const annotation = annotationById.get(id);
    const dependents = impact.blastRadius.entities.map(entity => entity.id);
    const receivers = receiversOf(impact);
    const scopeIds = [id, ...dependents, ...receivers.map(target => target.entity.id)];
    const hiddenReceivers = (impact.receivesChangedValue?.length ?? 0) - receivers.length;
    if (hiddenReceivers > 0) omitted.push(`${hiddenReceivers} code locations that receive a changed value`);
    const areas = map
      ? findSurfacesForEntity(map, relations, id, MAX_AREAS_PER_CHANGE * 2).map(item => describeArea(item.surface, item.path))
        .sort((a, b) => (criticalityRank[a.feature?.criticality ?? 'normal']! - criticalityRank[b.feature?.criticality ?? 'normal']!) || a.distance - b.distance)
      : [];
    if (areas.length > MAX_AREAS_PER_CHANGE) omitted.push(`${areas.length - MAX_AREAS_PER_CHANGE} more reachable surfaces for one change`);
    const featureIds = new Set([
      ...scopeIds.flatMap(entityId => annotationById.get(entityId)?.featureIds ?? []),
      ...context.features.filter(feature => areas.some(area => feature.surfaceIds.includes(area.surfaceId))).map(feature => feature.id),
    ]);
    const changedFile = impact.changedEntity.file;
    const rules = context.rules.filter(rule => rule.entityIds.some(entityId => entityId === id) ||
      (rule.entityIds.some(entityId => dependents.includes(entityId))) || (rule.files ?? []).includes(changedFile));
    rules.sort((a, b) => Number(!a.entityIds.includes(id)) - Number(!b.entityIds.includes(id)));
    if (rules.length > MAX_RULES) omitted.push(`${rules.length - MAX_RULES} related rules`);
    const dependentMeanings = dependents.map(entityId => annotationById.get(entityId)).filter((item): item is EntityAnnotationV2 => Boolean(item))
      .map(item => ({ entityId: item.entityId, businessMeaning: item.businessMeaning, userVisibleEffect: item.userVisibleEffect }));
    if (dependentMeanings.length > MAX_DEPENDENT_MEANINGS) omitted.push(`${dependentMeanings.length - MAX_DEPENDENT_MEANINGS} dependent descriptions`);
    const unannotatedByFile = new Map<string, string[]>();
    for (const entityId of dependents) {
      const file = fileOf(entityId);
      if (annotationById.has(entityId) || !fileRoleOf.has(file)) continue;
      unannotatedByFile.set(file, [...(unannotatedByFile.get(file) ?? []), entityId]);
    }
    const dependentFileRoles = [...unannotatedByFile].map(([file, entityIds]) => ({ file, role: fileRoleOf.get(file)!, entityIds }));
    if (dependentFileRoles.length > MAX_DEPENDENT_MEANINGS) omitted.push(`${dependentFileRoles.length - MAX_DEPENDENT_MEANINGS} dependent file roles`);
    return {
      changedEntityId: id,
      changedBehaviour: annotation ? {
        businessMeaning: annotation.businessMeaning, userVisibleEffect: annotation.userVisibleEffect, basis: annotation.basis,
        confidence: annotation.confidence, describes: versionOf(annotation, map, changedIds),
      } : null,
      features: [...featureIds].map(featureId => featureById.get(featureId)).filter(Boolean)
        .map(feature => ({ id: feature!.id, name: feature!.name, criticality: feature!.criticality, criticalityReason: feature!.criticalityReason })),
      ...(fileRoleOf.has(changedFile) ? { fileRole: fileRoleOf.get(changedFile)! } : {}),
      ...(receivers.length > 0 ? { receivesChangedValue: receivers.map(target => ({
        entityId: target.entity.id, receivedThrough: target.through, ...(meaningOf(target.entity.id) ? { meaning: meaningOf(target.entity.id)! } : {}),
        ...(target.reliesOnRemovedCharacters?.length ? { assumptionConflict: describeConflict(target.reliesOnRemovedCharacters) } : {}),
      })) } : {}),
      affectedAreas: areas.slice(0, MAX_AREAS_PER_CHANGE),
      dependentMeanings: dependentMeanings.slice(0, MAX_DEPENDENT_MEANINGS),
      dependentFileRoles: dependentFileRoles.slice(0, MAX_DEPENDENT_MEANINGS),
      rules: rules.slice(0, MAX_RULES).map(rule => ({
        statement: rule.statement, kind: rule.kind, basis: rule.basis,
        // A rule written from code before this change describes the old behaviour of the changed function.
        describes: rule.entityIds.includes(id) ? versionOf(annotation, map, changedIds) : 'unknown-version',
      })),
      openQuestions: context.openQuestions.filter(question => question.entityIds.some(entityId => scopeIds.includes(entityId)) ||
        question.featureIds.some(featureId => featureIds.has(featureId))).slice(0, 5).map(question => question.question),
    };
  });

  const corpusTokens = new Set<string>();
  const corpusText = [
    ...impacts.flatMap(impact => [impact.change.diff, impact.changedEntity.name]),
    ...changes.flatMap(change => [change.changedBehaviour?.businessMeaning ?? '', ...change.rules.map(rule => rule.statement),
      ...change.affectedAreas.flatMap(area => area.visibleText)]),
  ].join(' ');
  for (const token of corpusText.match(/[A-Za-z_$][\w$]*/g) ?? []) corpusTokens.add(token);
  const lowerCorpus = `${corpusText.toLowerCase()} ${[...corpusTokens].map(splitIdentifier).join(' ')}`;
  const glossary = context.glossary.filter(item => item.identifiers.some(identifier => corpusTokens.has(identifier)) ||
    (item.term.trim().length > 2 && lowerCorpus.includes(item.term.toLowerCase())))
    .slice(0, MAX_GLOSSARY).map(({ term, identifiers, meaning }) => ({ term, identifiers, meaning }));

  const pack: ContextPack = {
    application: {
      name: context.application.name, summary: context.application.summary, purpose: context.application.purpose,
      platform: context.application.platform, userRoles: context.application.userRoles.map(({ name, description }) => ({ name, description })),
    },
    changes,
    glossary,
    entityAnnotations: context.entityAnnotations.filter(annotation => relevantIds.has(annotation.entityId)),
    unmappedEntityIds: [...relevantIds].filter(id => !annotationById.has(id) && !fileRoleOf.has(fileOf(id))),
    allowedSurfaceIds: [...new Set(changes.flatMap(change => change.affectedAreas.flatMap(area => [area.surfaceId, ...area.usedByPages.map(page => page.surfaceId)])))].sort(),
    contextStatus: {
      schemaVersion: '2.0', ...(context.meta.migratedFrom ? { migratedFrom: context.meta.migratedFrom } : {}),
      generatedAt: context.meta.generatedAt, coverage: context.meta.coverage, warnings: options.warnings ?? [],
    },
    omitted,
  };

  // Enforce the size budget by dropping the least important detail first.
  const shrinkSteps: Array<[string, () => void]> = [
    ['changed value receivers', () => pack.changes.forEach(change => { if (change.receivesChangedValue) change.receivesChangedValue = change.receivesChangedValue.slice(0, 3); })],
    ['end-to-end flow steps', () => pack.changes.forEach(change => change.affectedAreas.forEach(area => { area.e2eFlows = area.e2eFlows.slice(0, 1).map(flow => ({ ...flow, steps: flow.steps.slice(0, 5) })); }))],
    ['dependent descriptions', () => pack.changes.forEach(change => {
      change.dependentMeanings = change.dependentMeanings.slice(0, 4);
      change.dependentFileRoles = change.dependentFileRoles.slice(0, 4);
    })],
    ['compatibility annotations', () => { pack.entityAnnotations = pack.entityAnnotations.filter(annotation => changedIds.has(annotation.entityId)); }],
    ['visible text', () => pack.changes.forEach(change => change.affectedAreas.forEach(area => { area.visibleText = area.visibleText.slice(0, 3); }))],
    ['lower-priority affected areas', () => pack.changes.forEach(change => { change.affectedAreas = change.affectedAreas.slice(0, 3); })],
  ];
  for (const [label, shrink] of shrinkSteps) {
    if (JSON.stringify(pack).length <= PACK_BUDGET_CHARS) break;
    shrink();
    pack.omitted.push(`trimmed ${label} to fit the request budget`);
  }
  return pack;
}
