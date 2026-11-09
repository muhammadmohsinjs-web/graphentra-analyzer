import type { ApplicationMap, SurfaceProvenance } from './application-map';
import { ADAPTERS } from './adapters/registry';
import { ADAPTER_VERSION, type FrameworkAdapter } from './adapters/types';
import type { AdapterRecord, DiagnosticItem, EdgeConfidence, SurfaceEdge, SurfaceNode } from './contracts';
import { compareStrings } from './deterministic';
import { frameworkLabel, type FrameworkDetection } from './framework-version';

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
  /** One FRAMEWORK_VERSION_NOT_CERTIFIED info per adapter whose framework major is unknown or uncertified (D11). */
  diagnostics: DiagnosticItem[];
}

interface AdapterInfo {
  record: AdapterRecord;
  detection?: FrameworkDetection;
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
    const info: AdapterInfo = { record, ...(detection ? { detection } : {}) };
    adapterInfo.set(adapterId, info);
    return info;
  };

  const surfaces: SurfaceNode[] = [];
  const surfaceEdges: SurfaceEdge[] = [];
  for (const surface of input.map.surfaces) {
    // Every map surface is recorded by its adapter; the fallback only guards a missing provenance entry.
    const origin = input.provenance.get(surface.id) ?? { adapterId: surface.source, adapterVersion: ADAPTER_VERSION };
    const { detection } = infoFor(origin.adapterId, origin.adapterVersion);
    // D11: a detected framework with an unknown or uncertified major still runs, but its surfaces are only likely.
    const confidence: EdgeConfidence = detection && !detection.certified ? 'likely' : 'proven';
    const framework = detection ? frameworkLabel(detection) : undefined;
    const handlerEntityIds = [...new Set(surface.entryEntityIds.filter(id => input.entityIds.has(id)))].sort(compareStrings);
    surfaces.push({
      id: surface.id, kind: surface.kind, route: surface.route, ...(surface.method ? { method: surface.method } : {}),
      file: surface.file, line: surface.line, handlerEntityIds, ...(framework ? { framework } : {}),
      adapter: { id: origin.adapterId, version: origin.adapterVersion }, confidence, source: 'detected',
    });
    for (const entityId of handlerEntityIds) surfaceEdges.push({ from: surface.id, to: entityId, type: 'SURFACE_HANDLED_BY', confidence });
  }
  surfaces.sort((a, b) => compareStrings(a.id, b.id));
  surfaceEdges.sort((a, b) => compareStrings(`${a.from}|${a.type}|${a.to}`, `${b.from}|${b.type}|${b.to}`));

  const infos = [...adapterInfo.values()].sort((a, b) => compareStrings(a.record.id, b.record.id));
  const diagnostics: DiagnosticItem[] = [];
  for (const { record, detection } of infos) {
    if (!detection || detection.certified) continue;
    const version = record.detectedVersion ?? 'unknown version';
    diagnostics.push({ code: 'FRAMEWORK_VERSION_NOT_CERTIFIED', severity: 'info',
      message: `Adapter ${record.id} ran on ${detection.framework} ${version}, which is not a certified major; its surfaces are reported as likely.` });
  }
  return { surfaces, surfaceEdges, adapters: infos.map(info => info.record), diagnostics };
}
