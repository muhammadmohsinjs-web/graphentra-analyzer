import type { ApplicationMap, SurfaceProvenance } from './application-map';
import { ADAPTERS } from './adapters/registry';
import { ADAPTER_VERSION, type FrameworkAdapter } from './adapters/types';
import type { AdapterRecord, DiagnosticItem, EdgeConfidence, SurfaceEdge, SurfaceNode } from './contracts';
import { compareStrings } from './deterministic';
import { normalizeNextRoute } from './adapters/nextjs-files';
import { frameworkLabel, nextRouterRules, type FrameworkDetection } from './framework-version';

/** Next.js map sources whose routes are projected into the `:param` form in 3.0 (D4); the map keeps `[id]`. */
const NEXT_SOURCES = new Set(['next-app-router', 'next-pages-router', 'next-route-handler']);
/** Next.js map sources that exist only with the app/ router (Next.js 13+, D11). */
const NEXT_APP_ROUTER_SOURCES = new Set(['next-app-router', 'next-route-handler']);
/**
 * Fallback for provenance entries without `dependencyGated`: the adapters that only ever run because their framework
 * package is a dependency (`detectByDependency`). The analyzer records the flag from each adapter's detect evidence
 * (anything but `syntactic` is dependency-gated), which also covers express and http-router when they ran on a
 * declared package. Without a detected version such a framework's major is unknown, so D11 applies: surfaces are likely,
 * with a diagnostic. Syntactic adapters have no framework package to version and keep proven surfaces.
 */
export const DEPENDENCY_GATED_ADAPTERS = new Set(['nextjs-app-router', 'nextjs-pages-router', 'nextjs-route-handler']);

/** The 3.0 id and route of a map surface: Next.js dynamic segments in `:param` form; everything else unchanged. */
export function projectSurfaceRoute(surface: { id: string; kind: string; route: string; method?: string; source: string }):
  { id: string; route: string } {
  if (!NEXT_SOURCES.has(surface.source)) return { id: surface.id, route: surface.route };
  const route = normalizeNextRoute(surface.route);
  if (route === surface.route) return { id: surface.id, route };
  return { id: surface.kind === 'ui_route' ? `ui:${route}` : `api:${surface.method ?? 'ANY'} ${route}`, route };
}

export interface BuildSurfaceEvidenceInput {
  map: ApplicationMap;
  provenance: SurfaceProvenance;
  frameworkVersions: readonly FrameworkDetection[];
  /** Entity ids of the head technical graph; handler ids outside it are dropped (the validator requires them). */
  entityIds: ReadonlySet<string>;
  /**
   * Framework versions that apply to one project-relative surface file: the manifest that gated it (nearest
   * package.json) plus its workspace lockfile entry (D11, monorepos). Default: `frameworkVersions` for every file.
   */
  frameworkVersionsFor?: (file: string) => readonly FrameworkDetection[];
  /** Adapter metadata used to map an adapter to its framework (default: the built-in registry). */
  adapters?: readonly FrameworkAdapter[];
}

export interface SurfaceEvidence {
  /** Sorted by id. */
  surfaces: SurfaceNode[];
  /** SURFACE_HANDLED_BY only (surface → handler entity), sorted by from, type, to. */
  surfaceEdges: SurfaceEdge[];
  /** Adapters that contributed at least one surface, sorted by id. */
  adapters: AdapterRecord[];
  /**
   * One FRAMEWORK_VERSION_NOT_CERTIFIED info per adapter whose framework major is unknown or uncertified (D11), and one
   * NEXT_APP_ROUTER_UNSUPPORTED info when app/ surfaces are dropped because the detected Next.js major is below 13.
   */
  diagnostics: DiagnosticItem[];
}

interface AdapterInfo {
  id: string;
  version: string;
  /** The first detection seen (surfaces are visited in sorted map id order), recorded on the adapter. */
  first?: FrameworkDetection;
  /** Every surface had a certified detection. */
  allCertified: boolean;
  /** Uncertified detections by `framework|version`, one diagnostic each. */
  uncertified: Map<string, FrameworkDetection>;
  /** A dependency-gated surface ran with no detected framework version (D11: unknown major). */
  versionUnknown: boolean;
}

const weaker = (a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence => (a === 'likely' || b === 'likely' ? 'likely' : 'proven');
const versionOf = (detection: FrameworkDetection): string => detection.resolved ?? detection.declared ?? 'unknown version';

/**
 * Projects the application map onto evidence 3.0 surfaces (D4). Only identity, routing, handler and provenance
 * fields enter evidence; presentation extras (uiText, textKeys, navigation, access, e2e flows) stay in the map.
 * D11 applies per surface, with the framework version of the manifest that gated the surface's file.
 */
export function buildSurfaceEvidence(input: BuildSurfaceEvidenceInput): SurfaceEvidence {
  const registry = new Map((input.adapters ?? ADAPTERS).map(adapter => [adapter.id, adapter]));
  const projectDetections = [...input.frameworkVersions].sort((a, b) => compareStrings(a.framework, b.framework));
  const detectionsFor = (file: string): readonly FrameworkDetection[] =>
    input.frameworkVersionsFor ? [...input.frameworkVersionsFor(file)].sort((a, b) => compareStrings(a.framework, b.framework)) : projectDetections;
  const adapterInfo = new Map<string, AdapterInfo>();

  const byId = new Map<string, SurfaceNode>();
  const droppedAppRouter = new Map<string, string[]>();
  for (const surface of [...input.map.surfaces].sort((a, b) => compareStrings(a.id, b.id))) {
    const detections = detectionsFor(surface.file);
    // D11: app/ is a router only from Next.js 13 on. The 2.x map keeps these surfaces as on base; 3.0 drops them.
    const nextDetection = detections.find(item => item.framework === 'next');
    if (NEXT_APP_ROUTER_SOURCES.has(surface.source) && nextDetection && !nextRouterRules(nextDetection.major).appRouter) {
      const version = versionOf(nextDetection);
      droppedAppRouter.set(version, [...(droppedAppRouter.get(version) ?? []), surface.id]);
      continue;
    }
    // Every map surface is recorded by its adapter; the fallback only guards a missing provenance entry.
    const origin = input.provenance.get(surface.id) ?? { adapterId: surface.source, adapterVersion: ADAPTER_VERSION };
    const frameworks = registry.get(origin.adapterId)?.frameworks ?? [];
    const detection = detections.find(item => frameworks.includes(item.framework));
    const gated = origin.dependencyGated ?? DEPENDENCY_GATED_ADAPTERS.has(origin.adapterId);
    const versionUnknown = !detection && gated;
    let info = adapterInfo.get(origin.adapterId);
    if (!info) {
      info = { id: origin.adapterId, version: origin.adapterVersion, allCertified: true, uncertified: new Map(), versionUnknown: false };
      adapterInfo.set(origin.adapterId, info);
    }
    if (detection) {
      info.first ??= detection;
      if (!detection.certified) info.uncertified.set(`${detection.framework}|${versionOf(detection)}`, detection);
    }
    if (!detection?.certified) info.allCertified = false;
    if (versionUnknown) info.versionUnknown = true;
    // D11: a detected framework with an unknown or uncertified major still runs, but its surfaces are only likely.
    const confidence: EdgeConfidence = (detection && !detection.certified) || versionUnknown ? 'likely' : 'proven';
    const framework = detection ? frameworkLabel(detection) : undefined;
    const { id, route } = projectSurfaceRoute(surface);
    const handlers = surface.entryEntityIds.filter(entityId => input.entityIds.has(entityId));
    const existing = byId.get(id);
    if (existing) {
      // Two map ids can project to one 3.0 id (`[id]` and `:id`): the first (by map id) keeps its location fields,
      // handlers are merged and the weaker confidence wins, so the result does not depend on which one came first.
      existing.handlerEntityIds = [...new Set([...existing.handlerEntityIds, ...handlers])].sort(compareStrings);
      existing.confidence = weaker(existing.confidence, confidence);
      continue;
    }
    byId.set(id, {
      id, kind: surface.kind, route, ...(surface.method ? { method: surface.method } : {}),
      file: surface.file, line: surface.line, handlerEntityIds: [...new Set(handlers)].sort(compareStrings), ...(framework ? { framework } : {}),
      adapter: { id: origin.adapterId, version: origin.adapterVersion }, confidence, source: 'detected',
    });
  }
  const surfaces = [...byId.values()];
  const surfaceEdges: SurfaceEdge[] = [];
  for (const surface of surfaces) {
    for (const entityId of surface.handlerEntityIds) surfaceEdges.push({ from: surface.id, to: entityId, type: 'SURFACE_HANDLED_BY', confidence: surface.confidence });
  }
  surfaces.sort((a, b) => compareStrings(a.id, b.id));
  surfaceEdges.sort((a, b) => compareStrings(`${a.from}|${a.type}|${a.to}`, `${b.from}|${b.type}|${b.to}`));

  const infos = [...adapterInfo.values()].sort((a, b) => compareStrings(a.id, b.id));
  const records: AdapterRecord[] = [];
  const diagnostics: DiagnosticItem[] = [];
  for (const info of infos) {
    const detectedVersion = info.first ? info.first.resolved ?? info.first.declared : undefined;
    records.push({
      id: info.id, version: info.version,
      ...(info.first ? { framework: info.first.framework } : {}),
      ...(detectedVersion ? { detectedVersion } : {}),
      certified: info.first !== undefined && info.allCertified,
    });
    if (info.versionUnknown) {
      diagnostics.push({ code: 'FRAMEWORK_VERSION_NOT_CERTIFIED', severity: 'info',
        message: `Adapter ${info.id} ran without a detected framework version in the package.json that declares it; its surfaces are reported as likely.` });
    }
    for (const key of [...info.uncertified.keys()].sort(compareStrings)) {
      const detection = info.uncertified.get(key)!;
      diagnostics.push({ code: 'FRAMEWORK_VERSION_NOT_CERTIFIED', severity: 'info',
        message: `Adapter ${info.id} ran on ${detection.framework} ${versionOf(detection)}, which is not a certified major; its surfaces are reported as likely.` });
    }
  }
  for (const version of [...droppedAppRouter.keys()].sort(compareStrings)) {
    const dropped = [...droppedAppRouter.get(version)!].sort(compareStrings);
    diagnostics.push({ code: 'NEXT_APP_ROUTER_UNSUPPORTED', severity: 'info',
      message: `Next.js ${version} is below 13, where app/ is not a router; ${dropped.length} app/ surface(s) are left out of evidence: ${dropped.join(', ')}.` });
  }
  return { surfaces, surfaceEdges, adapters: records, diagnostics };
}
