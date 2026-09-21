import Ajv2020 from 'ajv/dist/2020';
const structuralValidator = new Ajv2020({ allErrors: true, strict: true }).compile(require('../evidence.schema.json'));
import {
  ANALYZER_VERSION,
  EVIDENCE_ARTIFACT_KIND,
  EVIDENCE_SCHEMA_VERSION,
  MAX_BLAST_DEPTH,
  type DeterministicEvidence,
  type Entity,
  type Relation,
} from './contracts';
import { EvidenceValidationError } from './errors';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function validateEvidenceEnvelope(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!structuralValidator(data)) return { valid: false, errors: (structuralValidator.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`) };

  if (!isObject(data)) {
    return { valid: false, errors: ['Evidence envelope must be a non-null object.'] };
  }

  // Identity & versions
  if (data.artifactKind !== EVIDENCE_ARTIFACT_KIND) {
    errors.push(`Expected artifactKind "${EVIDENCE_ARTIFACT_KIND}", got "${String(data.artifactKind)}".`);
  }
  if (data.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    errors.push(`Expected schemaVersion "${EVIDENCE_SCHEMA_VERSION}", got "${String(data.schemaVersion)}".`);
  }
  if (typeof data.analyzerVersion !== 'string' || !data.analyzerVersion) {
    errors.push('Expected non-empty string for analyzerVersion.');
  }

  // Target
  if (!isObject(data.target) || typeof data.target.targetPath !== 'string' || !data.target.targetPath) {
    errors.push('Expected target.targetPath to be a non-empty string.');
  } else if (data.target.targetPath.startsWith('/') || /^[a-zA-Z]:\\/.test(data.target.targetPath)) {
    errors.push(`target.targetPath must be a repository-relative path, not an absolute path: "${data.target.targetPath}".`);
  }

  // Comparison
  if (!isObject(data.comparison)) {
    errors.push('Expected comparison to be an object.');
  } else {
    const comp = data.comparison;
    if (comp.mode !== 'commit' && comp.mode !== 'working-tree') {
      errors.push(`comparison.mode must be "commit" or "working-tree", got "${String(comp.mode)}".`);
    }
    if (typeof comp.resolvedBaseSha !== 'string' || !comp.resolvedBaseSha) {
      errors.push('comparison.resolvedBaseSha must be a non-empty string.');
    }
    if (comp.mode === 'commit' && (typeof comp.resolvedHeadSha !== 'string' || !comp.resolvedHeadSha)) {
      errors.push('comparison.resolvedHeadSha must be a non-empty string in commit mode.');
    }
    if (typeof comp.comparedTo !== 'string') {
      errors.push('comparison.comparedTo must be a string.');
    }
  }

  // Source state
  if (!isObject(data.sourceState)) {
    errors.push('Expected sourceState to be an object.');
  } else {
    if (typeof data.sourceState.contentIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(data.sourceState.contentIdentity)) {
      errors.push('sourceState.contentIdentity must be a SHA-256 digest of captured inputs.');
    }
    if (typeof data.sourceState.checkoutSha !== 'string' || !data.sourceState.checkoutSha) {
      errors.push('sourceState.checkoutSha must be a non-empty string.');
    }
    if (typeof data.sourceState.isTrackedDirty !== 'boolean') {
      errors.push('sourceState.isTrackedDirty must be a boolean.');
    }
    if (
      data.sourceState.untrackedSourcePolicy !== 'excluded' &&
      data.sourceState.untrackedSourcePolicy !== 'included'
    ) {
      errors.push('sourceState.untrackedSourcePolicy must be "excluded" or "included".');
    }
  }

  if (!isObject(data.options) || !Array.isArray(data.options.excludePaths) ||
      data.options.excludePaths.some(value => typeof value !== 'string') ||
      !['git-tracked', 'git-tracked-and-nonignored-untracked'].includes(String(data.options.sourcePolicy))) {
    errors.push('Expected recorded exclusions and source policy in options.');
  }

  // Outcome
  const validOutcomes = new Set([
    'completed',
    'no_source_files',
    'no_changes',
    'no_supported_changes',
  ]);
  if (typeof data.outcome !== 'string' || !validOutcomes.has(data.outcome)) {
    errors.push(`Invalid outcome: "${String(data.outcome)}". Must be one of: completed, no_source_files, no_changes, no_supported_changes.`);
  }

  // Technical graph
  const entityMap = new Map<string, Entity>();
  const relationPairSet = new Set<string>();

  if (!isObject(data.technicalGraph)) {
    errors.push('Expected technicalGraph to be an object.');
  } else {
    const tg = data.technicalGraph;
    if (tg.schemaVersion !== '1.0') {
      errors.push(`technicalGraph.schemaVersion must be "1.0", got "${String(tg.schemaVersion)}".`);
    }
    if (!isObject(tg.capabilities)) {
      errors.push('technicalGraph.capabilities must be an object.');
    }
    if (!Array.isArray(tg.analyzedFiles)) {
      errors.push('technicalGraph.analyzedFiles must be an array.');
    }
    if (!Array.isArray(tg.entities)) {
      errors.push('technicalGraph.entities must be an array.');
    } else {
      const seenEntityIds = new Set<string>();
      for (let i = 0; i < tg.entities.length; i++) {
        const entity = tg.entities[i] as Entity;
        if (!isObject(entity)) {
          errors.push(`technicalGraph.entities[${i}] must be an object.`);
          continue;
        }
        if (typeof entity.id !== 'string' || !entity.id) {
          errors.push(`technicalGraph.entities[${i}].id must be a non-empty string.`);
        } else if (seenEntityIds.has(entity.id)) {
          errors.push(`Duplicate entity ID discovered in technicalGraph: "${entity.id}".`);
        } else {
          seenEntityIds.add(entity.id);
          entityMap.set(entity.id, entity);
        }
        if (entity.kind !== 'function') {
          errors.push(`technicalGraph.entities[${i}].kind must be "function".`);
        }
        if (typeof entity.startLine !== 'number' || entity.startLine < 1) {
          errors.push(`Entity "${entity.id}" has invalid startLine: ${entity.startLine}. Must be >= 1.`);
        }
        if (typeof entity.endLine !== 'number' || entity.endLine < entity.startLine) {
          errors.push(`Entity "${entity.id}" has endLine (${entity.endLine}) < startLine (${entity.startLine}).`);
        }
      }
    }

    if (!Array.isArray(tg.relations)) {
      errors.push('technicalGraph.relations must be an array.');
    } else {
      for (let i = 0; i < tg.relations.length; i++) {
        const relation = tg.relations[i] as Relation;
        if (!isObject(relation)) {
          errors.push(`technicalGraph.relations[${i}] must be an object.`);
          continue;
        }
        if (relation.type !== 'CALLS') {
          errors.push(`technicalGraph.relations[${i}].type must be "CALLS".`);
        }
        if (!entityMap.has(relation.from)) {
          errors.push(`technicalGraph.relations[${i}].from endpoint "${relation.from}" not found in entities.`);
        }
        if (!entityMap.has(relation.to)) {
          errors.push(`technicalGraph.relations[${i}].to endpoint "${relation.to}" not found in entities.`);
        }
        relationPairSet.add(`${relation.from}->${relation.to}`);
      }
    }
  }

  // Changed files, changed entities, impacts
  if (!Array.isArray(data.changedFiles)) {
    errors.push('changedFiles must be an array.');
  }
  if (!Array.isArray(data.changedEntities)) {
    errors.push('changedEntities must be an array.');
  }
  if (!Array.isArray(data.impacts)) {
    errors.push('impacts must be an array.');
  } else {
    for (let i = 0; i < data.impacts.length; i++) {
      const impact = data.impacts[i] as any;
      if (!isObject(impact)) {
        errors.push(`impacts[${i}] must be an object.`);
        continue;
      }
      const changedEntity = impact.changedEntity as Entity | undefined;
      if (!isObject(changedEntity) || typeof changedEntity.id !== 'string' || !entityMap.has(changedEntity.id)) {
        errors.push(`impacts[${i}].changedEntity must exist in technicalGraph.entities.`);
      }
      if (isObject(impact.blastRadius) && Array.isArray(impact.blastRadius.paths)) {
        for (let pIdx = 0; pIdx < impact.blastRadius.paths.length; pIdx++) {
          const pathInfo = impact.blastRadius.paths[pIdx] as any;
          if (!isObject(pathInfo) || !Array.isArray(pathInfo.path)) {
            errors.push(`impacts[${i}].blastRadius.paths[${pIdx}] must have a path array.`);
            continue;
          }
          const pathArr = pathInfo.path as Entity[];
          if (pathArr.length === 0) {
            errors.push(`impacts[${i}].blastRadius.paths[${pIdx}] path array cannot be empty.`);
            continue;
          }
          const depth = typeof pathInfo.depth === 'number' ? pathInfo.depth : -1;
          if (depth !== pathArr.length - 1) {
            errors.push(`impacts[${i}].blastRadius.paths[${pIdx}] depth (${depth}) does not match path length - 1 (${pathArr.length - 1}).`);
          }
          if (depth > MAX_BLAST_DEPTH) {
            errors.push(`impacts[${i}].blastRadius.paths[${pIdx}] depth (${depth}) exceeds MAX_BLAST_DEPTH (${MAX_BLAST_DEPTH}).`);
          }
          // Path continuity check: each step is connected by relation in reverse (caller -> callee)
          for (let step = 0; step < pathArr.length - 1; step++) {
            const callee = pathArr[step];
            const caller = pathArr[step + 1];
            if (!relationPairSet.has(`${caller.id}->${callee.id}`)) {
              errors.push(`Path discontinuity at step ${step}: "${caller.id}" does not call "${callee.id}".`);
            }
          }
        }
      }
    }
  }

  const evidence = data as unknown as DeterministicEvidence;
  const graph = evidence.technicalGraph;
  const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
  function canonical(value: any): string {
    return JSON.stringify(value && typeof value === 'object'
      ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
        : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))]))
      : value);
  }
  function canonicalEntity(entity: Entity) {
    if (!equal(entityMap.get(entity.id), entity)) errors.push('Embedded entity differs from canonical graph entity.');
  }
  function sameSet(actual: string[], expected: string[], label: string) {
    if (new Set(actual).size !== actual.length || !equal([...actual].sort(), [...new Set(expected)].sort())) errors.push(`${label} set mismatch or duplicate.`);
  }
  for (const entity of graph.entities) {
    if (entity.id !== `${entity.file}#${entity.name}` || !graph.analyzedFiles.includes(entity.file) || entity.startLine > entity.endLine) {
      errors.push('Entity identity, file membership, or range is inconsistent.');
    }
  }
  if (new Set(graph.relations.map(relation => JSON.stringify(relation))).size !== graph.relations.length) errors.push('Duplicate relation.');
  if (graph.repository.targetPath !== evidence.target.targetPath || graph.repository.analyzerVersion !== evidence.analyzerVersion ||
      graph.repository.headSha !== evidence.sourceState.checkoutSha) errors.push('Graph metadata disagrees with envelope.');
  if (evidence.comparison.mode === 'commit' && (evidence.sourceState.isTrackedDirty ||
      evidence.sourceState.untrackedSourcePolicy !== 'excluded' || evidence.comparison.resolvedHeadSha !== evidence.sourceState.checkoutSha ||
      evidence.options.sourcePolicy !== 'git-tracked')) errors.push('Commit source policy or checkout mismatch.');
  if (evidence.comparison.mode === 'working-tree' && (evidence.sourceState.untrackedSourcePolicy !== 'included' ||
      evidence.options.sourcePolicy !== 'git-tracked-and-nonignored-untracked')) errors.push('Working-tree source policy mismatch.');
  sameSet(evidence.impacts.map(item => item.changedEntity.id), evidence.changedEntities.map(item => item.entity.id), 'Changed impacts');
  if (new Set(evidence.changedEntities.map(item => item.entity.id)).size !== evidence.changedEntities.length) errors.push('Duplicate changed entity.');
  for (const changed of evidence.changedEntities) {
    canonicalEntity(changed.entity);
    if (changed.change.file !== changed.entity.file || changed.change.changedLines.some(line => line < changed.entity.startLine || line > changed.entity.endLine)) errors.push('Changed lines or file outside entity.');
  }
  for (const impact of evidence.impacts) {
    canonicalEntity(impact.changedEntity);
    const changed = evidence.changedEntities.find(item => item.entity.id === impact.changedEntity.id);
    if (!changed || !equal(changed.change, impact.change)) errors.push('Impact change does not match changed entity.');
    const keys = new Set<string>();
    for (const recorded of impact.blastRadius.paths) {
      const nodes = recorded.path;
      for (const entity of [...nodes, recorded.target]) canonicalEntity(entity);
      if (nodes[0].id !== impact.changedEntity.id || nodes.at(-1)!.id !== recorded.target.id ||
          new Set(nodes.map(entity => entity.id)).size !== nodes.length) errors.push('Invalid path start, target, or cycle.');
      const key = JSON.stringify(nodes.map(entity => entity.id));
      if (keys.has(key)) errors.push('Duplicate impact path.');
      keys.add(key);
    }
    const affected = impact.blastRadius.paths.map(item => item.target.id);
    sameSet(impact.blastRadius.entities.map(item => item.id), affected, 'Affected entities');
    sameSet(impact.directDependents.map(item => item.id), impact.blastRadius.paths.filter(item => item.depth === 1).map(item => item.target.id), 'Direct dependents');
    sameSet(impact.terminalDependents.map(item => item.id), affected.filter(id => !graph.relations.some(relation => relation.to === id)), 'Terminal dependents');
    for (const entity of [...impact.blastRadius.entities, ...impact.directDependents, ...impact.terminalDependents]) canonicalEntity(entity);
    if (impact.blastRadius.totalAffectedEntities !== new Set(affected).size) errors.push('Affected entity count mismatch.');
  }
  for (const diagnostic of evidence.diagnostics) {
    if (diagnostic.entityId && !entityMap.has(diagnostic.entityId)) errors.push('Diagnostic entity is absent from graph.');
  }
  if (evidence.outcome !== 'completed' && (evidence.changedEntities.length || evidence.impacts.length)) errors.push('Empty outcome contains impacts.');
  if (evidence.outcome === 'no_source_files' && graph.analyzedFiles.length) errors.push('no_source_files contains source inventory.');
  if (evidence.outcome === 'completed' && (!evidence.changedFiles.length || !evidence.impacts.length)) errors.push('Completed outcome lacks changes or impacts.');
  if (evidence.outcome === 'no_supported_changes' && !evidence.changedFiles.length) errors.push('Unsupported outcome lacks changed files.');

  // Outcome consistency
  if (data.outcome === 'no_source_files') {
    if (entityMap.size > 0) {
      errors.push('Outcome "no_source_files" must not contain any entities.');
    }
  } else if (data.outcome === 'no_changes') {
    if (Array.isArray(data.changedFiles) && data.changedFiles.length > 0) {
      errors.push('Outcome "no_changes" must have empty changedFiles.');
    }
  } else if (data.outcome === 'no_supported_changes') {
    if (Array.isArray(data.changedEntities) && data.changedEntities.length > 0) {
      errors.push('Outcome "no_supported_changes" must have empty changedEntities.');
    }
  } else if (data.outcome === 'completed') {
    if (Array.isArray(data.changedEntities) && data.changedEntities.length === 0) {
      errors.push('Outcome "completed" must have at least one changed entity.');
    }
  }

  if (!Array.isArray(data.limitations)) {
    errors.push('limitations must be an array.');
  }
  if (!Array.isArray(data.diagnostics)) {
    errors.push('diagnostics must be an array.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function assertValidEvidenceEnvelope(data: unknown): asserts data is DeterministicEvidence {
  const result = validateEvidenceEnvelope(data);
  if (!result.valid) {
    throw new EvidenceValidationError(result.errors);
  }
}
