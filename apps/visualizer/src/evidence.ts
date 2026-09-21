import Ajv2020 from 'ajv/dist/2020';
import { createHash } from 'node:crypto';
const schema = new Ajv2020({ strict: true, allErrors: true }).compile(require('../schema/evidence.schema.json'));
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const ordered = (items: any[]): any[] => [...items].sort((a, b) => {
  const left = JSON.stringify(canonical(a)), right = JSON.stringify(canonical(b));
  return left < right ? -1 : left > right ? 1 : 0;
});
export function computeEvidenceIdentity(evidence: any): string {
  const { generatedAt: _timestamp, ...repository } = evidence.technicalGraph.repository;
  const payload = { ...evidence,
    options: { ...evidence.options, excludePaths: ordered(evidence.options.excludePaths) },
    technicalGraph: { ...evidence.technicalGraph, repository, analyzedFiles: ordered(evidence.technicalGraph.analyzedFiles),
      entities: ordered(evidence.technicalGraph.entities), relations: ordered(evidence.technicalGraph.relations) },
    changedFiles: ordered(evidence.changedFiles), changedEntities: ordered(evidence.changedEntities),
    impacts: ordered(evidence.impacts.map((impact: any) => ({ ...impact,
      directDependents: ordered(impact.directDependents), terminalDependents: ordered(impact.terminalDependents),
      blastRadius: { ...impact.blastRadius, entities: ordered(impact.blastRadius.entities), paths: ordered(impact.blastRadius.paths) } }))),
    diagnostics: ordered(evidence.diagnostics), limitations: ordered(evidence.limitations) };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}
export function validateEvidenceEnvelope(value: unknown): { valid: boolean; errors: string[] } {
  if (!schema(value)) return { valid: false, errors: (schema.errors ?? []).map(error => `${error.instancePath}: ${error.message}`) };
  const data: any = value;
  const errors: string[] = [];
  const graph = data.technicalGraph;
  const entities = new Map<string, any>(graph.entities.map((entity: any) => [entity.id, entity]));
  const edge = (from: string, to: string) => JSON.stringify([from, to]);
  const edges = new Set<string>(graph.relations.map((relation: any) => edge(relation.from, relation.to)));
  const check = (condition: boolean, message: string) => { if (!condition) errors.push(message); };
  const reference = (entity: any) => check(equal(entities.get(entity.id), entity), 'Entity reference mismatch.');
  const sameSet = (actual: string[], expected: string[]) => new Set(actual).size === actual.length && equal([...actual].sort(), [...new Set(expected)].sort());
  check(entities.size === graph.entities.length, 'Duplicate entity.');
  check(edges.size === graph.relations.length, 'Duplicate relation.');
  for (const entity of graph.entities) check(entity.id === `${entity.file}#${entity.name}` && graph.analyzedFiles.includes(entity.file) && entity.startLine <= entity.endLine, 'Invalid entity identity or range.');
  for (const relation of graph.relations) check(entities.has(relation.from) && entities.has(relation.to), 'Missing relation endpoint.');
  check(graph.repository.targetPath === data.target.targetPath && graph.repository.analyzerVersion === data.analyzerVersion && graph.repository.headSha === data.sourceState.checkoutSha, 'Graph provenance mismatch.');
  check(data.comparison.mode === 'commit' ? !data.sourceState.isTrackedDirty && data.sourceState.untrackedSourcePolicy === 'excluded' && data.comparison.resolvedHeadSha === data.sourceState.checkoutSha && data.options.sourcePolicy === 'git-tracked'
    : data.sourceState.untrackedSourcePolicy === 'included' && data.options.sourcePolicy === 'git-tracked-and-nonignored-untracked', 'Source policy mismatch.');
  check(new Set(data.changedEntities.map((item: any) => item.entity.id)).size === data.changedEntities.length, 'Duplicate changed entity.');
  check(sameSet(data.impacts.map((item: any) => item.changedEntity.id), data.changedEntities.map((item: any) => item.entity.id)), 'Changed impacts mismatch.');
  for (const changed of data.changedEntities) {
    reference(changed.entity);
    check(changed.change.file === changed.entity.file && changed.change.changedLines.every((line: number) => line >= changed.entity.startLine && line <= changed.entity.endLine), 'Change range mismatch.');
  }
  for (const impact of data.impacts) {
    reference(impact.changedEntity);
    const changed = data.changedEntities.find((item: any) => item.entity.id === impact.changedEntity.id);
    check(Boolean(changed) && equal(changed.change, impact.change), 'Impact change mismatch.');
    const paths = new Set<string>();
    for (const record of impact.blastRadius.paths) {
      const ids = record.path.map((entity: any) => entity.id);
      for (const entity of [...record.path, record.target]) reference(entity);
      check(ids[0] === impact.changedEntity.id && ids.at(-1) === record.target.id && record.depth === ids.length - 1 && new Set(ids).size === ids.length, 'Path endpoints, depth or cycle invalid.');
      check(ids.slice(1).every((id: string, index: number) => edges.has(edge(id, ids[index]))), 'Reverse CALLS path mismatch.');
      check(!paths.has(JSON.stringify(ids)), 'Duplicate path.'); paths.add(JSON.stringify(ids));
    }
    const affected = impact.blastRadius.paths.map((item: any) => item.target.id);
    check(sameSet(impact.blastRadius.entities.map((entity: any) => entity.id), affected) && impact.blastRadius.totalAffectedEntities === new Set(affected).size, 'Affected entities mismatch.');
    check(sameSet(impact.directDependents.map((entity: any) => entity.id), impact.blastRadius.paths.filter((item: any) => item.depth === 1).map((item: any) => item.target.id)), 'Direct dependents mismatch.');
    check(sameSet(impact.terminalDependents.map((entity: any) => entity.id), affected.filter((id: string) => !graph.relations.some((relation: any) => relation.to === id))), 'Terminal dependents mismatch.');
    for (const entity of [...impact.blastRadius.entities, ...impact.directDependents, ...impact.terminalDependents]) reference(entity);
  }
  check(data.outcome === 'completed' ? data.changedFiles.length > 0 && data.changedEntities.length > 0 && data.impacts.length > 0 : data.changedEntities.length === 0 && data.impacts.length === 0, 'Outcome impacts mismatch.');
  if (data.outcome === 'no_source_files') check(graph.entities.length === 0 && graph.analyzedFiles.length === 0, 'Empty source mismatch.');
  if (data.outcome === 'no_changes') check(data.changedFiles.length === 0, 'Empty changes mismatch.');
  if (data.outcome === 'no_supported_changes') check(data.changedFiles.length > 0, 'Unsupported changes missing.');
  for (const diagnostic of data.diagnostics) if (diagnostic.entityId) check(entities.has(diagnostic.entityId), 'Unknown diagnostic entity.');
  return { valid: errors.length === 0, errors };
}
