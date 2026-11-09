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
 * Adapters that run only because their framework package is a dependency (`detectByDependency`). Without a
 * detected version their framework major is unknown, so D11 applies: surfaces are likely, with a diagnostic.
 * Syntactic adapters (route-config, react-router, nestjs, and express/http-router when they ran without the package)
 * have no framework package to version and keep proven surfaces.
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
  record: AdapterRecord;
  detection?: FrameworkDetection;
  /** Dependency-gated adapter that ran with no detected framework version (D11: unknown major). */
  versionUnknown: boolean;
}

/**
 * Projects the application map onto evidence 3.0 surfaces (D4). Only identity, routing, handler and provenance
 * fields enter evidence; presentation extras (uiText, textKeys, navigation, access, e2e flows) stay in the map.
 */
export function buildSurfaceEvidence(input: BuildSurfaceEvidenceInput): SurfaceEvidence {
  const registry = new Map((input.adapters ?? ADAPTERS).map(adapter => [adapter.id, adapter]));
  const detections = [...input.frameworkVersions].sort((a, b) => compareStrings(a.framework, b.framework));
  const adapterInfo = new Map<string, AdapterInfo>();
  const infoFor = (adapterId: string, adapterVersion: string): AdapterInfo => {
    const existing = adapterInfo.get(adapterId);
    if (existing) return existing;
    const frameworks = registry.get(adapterId)?.frameworks ?? [];
    const detection = detections.find(item => frameworks.includes(item.framework));
    const detectedVersion = detection ? detection.resolved ?? detection.declared : undefined;
    const record: AdapterRecord = {
      id: adapterId, version: adapterVersion,
      ...(detection ? { framework: detection.framework } : {}),
      ...(detectedVersion ? { detectedVersion } : {}),
      certified: detection?.certified ?? false,
    };
    const info: AdapterInfo = { record, ...(detection ? { detection } : {}), versionUnknown: !detection && DEPENDENCY_GATED_ADAPTERS.has(adapterId) };
    adapterInfo.set(adapterId, info);
    return info;
  };

  const byId = new Map<string, SurfaceNode>();
  const droppedAppRouter: string[] = [];
  const nextDetection = detections.find(item => item.framework === 'next');
  for (const surface of [...input.map.surfaces].sort((a, b) => compareStrings(a.id, b.id))) {
    // D11: app/ is a router only from Next.js 13 on. The 2.x map keeps these surfaces as on base; 3.0 drops them.
    if (NEXT_APP_ROUTER_SOURCES.has(surface.source) && !nextRouterRules(nextDetection?.major).appRouter) {
      droppedAppRouter.push(surface.id);
      continue;
    }
    // Every map surface is recorded by its adapter; the fallback only guards a missing provenance entry.
    const origin = input.provenance.get(surface.id) ?? { adapterId: surface.source, adapterVersion: ADAPTER_VERSION };
    const info = infoFor(origin.adapterId, origin.adapterVersion);
    const { detection } = info;
    // D11: a detected framework with an unknown or uncertified major still runs, but its surfaces are only likely.
    const confidence: EdgeConfidence = (detection && !detection.certified) || info.versionUnknown ? 'likely' : 'proven';
    const framework = detection ? frameworkLabel(detection) : undefined;
    const { id, route } = projectSurfaceRoute(surface);
    const handlers = surface.entryEntityIds.filter(entityId => input.entityIds.has(entityId));
    const existing = byId.get(id);
    if (existing) {
      // Two map ids can project to one 3.0 id (`[id]` and `:id`); the first keeps its fields, handlers are merged.
      existing.handlerEntityIds = [...new Set([...existing.handlerEntityIds, ...handlers])].sort(compareStrings);
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

  const infos = [...adapterInfo.values()].sort((a, b) => compareStrings(a.record.id, b.record.id));
  const diagnostics: DiagnosticItem[] = [];
  for (const { record, detection, versionUnknown } of infos) {
    if (versionUnknown) {
      diagnostics.push({ code: 'FRAMEWORK_VERSION_NOT_CERTIFIED', severity: 'info',
        message: `Adapter ${record.id} ran without a detected framework version in the project's package.json; its surfaces are reported as likely.` });
      continue;
    }
    if (!detection || detection.certified) continue;
    const version = record.detectedVersion ?? 'unknown version';
    diagnostics.push({ code: 'FRAMEWORK_VERSION_NOT_CERTIFIED', severity: 'info',
      message: `Adapter ${record.id} ran on ${detection.framework} ${version}, which is not a certified major; its surfaces are reported as likely.` });
  }
  if (droppedAppRouter.length > 0) {
    diagnostics.push({ code: 'NEXT_APP_ROUTER_UNSUPPORTED', severity: 'info',
      message: `Next.js ${nextDetection?.resolved ?? nextDetection?.declared ?? ''} is below 13, where app/ is not a router; ${droppedAppRouter.length} app/ surface(s) are left out of evidence: ${[...droppedAppRouter].sort(compareStrings).join(', ')}.` });
  }
  return { surfaces, surfaceEdges, adapters: infos.map(info => info.record), diagnostics };
}
