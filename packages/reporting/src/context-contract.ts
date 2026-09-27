import { z } from 'zod';
import type { TechnicalGraph } from '@graphentra/analyzer';
import { applicationContextSchema, type ApplicationContext } from './contracts';

/**
 * Application context v2: a business guide for the QA model.
 *
 * Every item is anchored to deterministic IDs (graph entities, application-map surfaces, files)
 * and carries a `basis` so the model can weigh reviewed/documented knowledge above inference.
 */
export const CONTEXT_PROMPT_VERSION = 'context-v2.1';

export const basisSchema = z.enum(['reviewed', 'documentation', 'tests', 'ui-text', 'code', 'inferred']);
export type Basis = z.infer<typeof basisSchema>;
export const criticalitySchema = z.enum(['critical', 'high', 'normal', 'low']);
export type Criticality = z.infer<typeof criticalitySchema>;

export const applicationContextV2Schema = z.object({
  schemaVersion: z.literal('2.0'),
  meta: z.object({
    generatedAt: z.string(),
    generator: z.object({ model: z.string(), promptVersion: z.string() }).strict(),
    sourceHeadSha: z.string(),
    analyzerVersion: z.string(),
    coverage: z.object({
      eligibleEntities: z.number().int().nonnegative(),
      annotatedEntities: z.number().int().nonnegative(),
      surfaces: z.number().int().nonnegative(),
      describedSurfaces: z.number().int().nonnegative(),
    }).strict(),
    unassignedFiles: z.array(z.string()),
    migratedFrom: z.literal('1.0').optional(),
    refreshedAt: z.string().optional(),
  }).strict(),
  application: z.object({
    name: z.string(),
    summary: z.string(),
    purpose: z.string(),
    platform: z.enum(['frontend', 'backend', 'fullstack', 'library', 'unknown']),
    userRoles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict()),
  }).strict(),
  features: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    criticality: criticalitySchema,
    criticalityReason: z.string(),
    files: z.array(z.string()),
    surfaceIds: z.array(z.string()),
    basis: basisSchema,
  }).strict()),
  surfaces: z.array(z.object({
    surfaceId: z.string(),
    businessName: z.string(),
    purpose: z.string(),
    featureIds: z.array(z.string()),
    howToReach: z.array(z.string()),
    access: z.string(),
    setup: z.array(z.string()),
    basis: basisSchema,
  }).strict()),
  glossary: z.array(z.object({
    term: z.string(),
    identifiers: z.array(z.string()),
    meaning: z.string(),
    basis: basisSchema,
  }).strict()),
  entityAnnotations: z.array(z.object({
    entityId: z.string(),
    fingerprint: z.string().optional(),
    businessMeaning: z.string(),
    userVisibleEffect: z.string(),
    featureIds: z.array(z.string()),
    basis: basisSchema,
    confidence: z.enum(['high', 'medium', 'low']),
  }).strict()),
  rules: z.array(z.object({
    id: z.string(),
    statement: z.string(),
    kind: z.enum(['observed', 'documented', 'tested']),
    entityIds: z.array(z.string()),
    featureIds: z.array(z.string()),
    basis: basisSchema,
  }).strict()),
  openQuestions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    entityIds: z.array(z.string()),
    featureIds: z.array(z.string()),
  }).strict()),
  unknowns: z.array(z.string()),
}).strict();

export type ApplicationContextV2 = z.infer<typeof applicationContextV2Schema>;
export type AnyApplicationContext = ApplicationContext | ApplicationContextV2;
export type EntityAnnotationV2 = ApplicationContextV2['entityAnnotations'][number];

export interface LoadedApplicationContext {
  context: ApplicationContextV2;
  /** Human-readable notes about dropped or migrated entries; never fatal. */
  warnings: string[];
}

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);

/** Converts the legacy v1 context in memory; the file on disk is never rewritten. */
export function migrateApplicationContextV1(context: ApplicationContext, graph: TechnicalGraph): ApplicationContextV2 {
  const entityByName = new Map<string, string[]>();
  for (const entity of graph.entities) entityByName.set(entity.name.toLowerCase(), [...(entityByName.get(entity.name.toLowerCase()) ?? []), entity.id]);
  const mentions = (text: string) => [...wordsOf(text)].flatMap(word => entityByName.get(word) ?? []);
  return {
    schemaVersion: '2.0',
    meta: {
      generatedAt: '', generator: { model: 'unknown', promptVersion: 'context-v1' }, sourceHeadSha: graph.repository.headSha,
      analyzerVersion: graph.repository.analyzerVersion,
      coverage: { eligibleEntities: graph.entities.length, annotatedEntities: context.entityAnnotations.length, surfaces: 0, describedSurfaces: 0 },
      unassignedFiles: [], migratedFrom: '1.0',
    },
    application: { ...context.application, platform: 'unknown', userRoles: [] },
    features: context.domains.map(domain => ({
      id: domain.id, name: domain.name, description: domain.description, criticality: 'normal', criticalityReason: '',
      files: [], surfaceIds: [], basis: 'inferred',
    })),
    surfaces: [],
    glossary: context.terminology.map(item => ({
      term: item.term, identifiers: /^[a-z]+[A-Z]|_|^[A-Z0-9_]+$/.test(item.term) ? [item.term] : [], meaning: item.meaning, basis: 'inferred',
    })),
    entityAnnotations: context.entityAnnotations.map(annotation => ({
      entityId: annotation.entityId, businessMeaning: annotation.businessMeaning, userVisibleEffect: '',
      featureIds: annotation.domainIds, basis: 'inferred', confidence: annotation.confidence,
    })),
    rules: context.applicationFacts.map((fact, index) => ({
      id: `fact-${index + 1}`, statement: fact, kind: 'observed', entityIds: [...new Set(mentions(fact))], featureIds: [], basis: 'code',
    })),
    openQuestions: [],
    unknowns: context.unknowns,
  };
}

/**
 * Parses v1 or v2 context and reconciles it with the current graph. Stale references (renamed or
 * deleted functions, unknown features) are dropped with a warning instead of failing the report.
 */
export function loadApplicationContext(value: unknown, graph: TechnicalGraph): LoadedApplicationContext {
  const warnings: string[] = [];
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  let context: ApplicationContextV2;
  if (version === '1.0') {
    context = migrateApplicationContextV1(applicationContextSchema.parse(value), graph);
    warnings.push('Application context uses schema 1.0; it was migrated in memory. Regenerate it with --generate-context for surfaces, rules, and criticality.');
  } else if (version === '2.0') {
    context = applicationContextV2Schema.parse(value);
  } else {
    throw new Error('Unsupported application context schemaVersion. Expected "1.0" or "2.0".');
  }
  const entityIds = new Set(graph.entities.map(entity => entity.id));
  const seenFeatures = new Set<string>();
  context.features = context.features.filter(feature => !seenFeatures.has(feature.id) && Boolean(seenFeatures.add(feature.id)));
  const featureIds = new Set(context.features.map(feature => feature.id));
  const seenAnnotations = new Set<string>();
  const before = context.entityAnnotations.length;
  context.entityAnnotations = context.entityAnnotations
    .filter(annotation => entityIds.has(annotation.entityId) && !seenAnnotations.has(annotation.entityId) && Boolean(seenAnnotations.add(annotation.entityId)))
    .map(annotation => ({ ...annotation, featureIds: annotation.featureIds.filter(id => featureIds.has(id)) }));
  if (context.entityAnnotations.length < before) {
    warnings.push(`${before - context.entityAnnotations.length} entity annotation(s) reference functions missing from the current graph and were ignored.`);
  }
  context.rules = context.rules.map(rule => ({
    ...rule, entityIds: rule.entityIds.filter(id => entityIds.has(id)), featureIds: rule.featureIds.filter(id => featureIds.has(id)),
  }));
  context.openQuestions = context.openQuestions.map(question => ({
    ...question, entityIds: question.entityIds.filter(id => entityIds.has(id)), featureIds: question.featureIds.filter(id => featureIds.has(id)),
  }));
  context.surfaces = context.surfaces.map(surface => ({ ...surface, featureIds: surface.featureIds.filter(id => featureIds.has(id)) }));
  return { context, warnings };
}
