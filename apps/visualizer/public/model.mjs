export function isTest(file) {
  return /(^|\/)(test|tests|__tests__)\//i.test(file.replace(/\\/g, '/')) || /(^|\/)(test|[^/]+\.(test|spec))\.(ts|tsx|mts|cts)$/i.test(file);
}

// Unknown or missing kinds fall back to the generic style; the class suffix is always CSS-safe.
export function kindOf(entity) {
  return typeof entity?.kind === 'string' && entity.kind ? entity.kind : 'function';
}
export const kindClass = entity => `kind-${kindOf(entity).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'}`;
// Module entities are all named `<module>`; append the file name so the label identifies the file.
export function displayName(entity) {
  return entity.name === '<module>' ? `<module> (${entity.file.replace(/\\/g, '/').split('/').at(-1)})` : entity.name;
}

export const edgeKey = (from, to) => JSON.stringify([from, to]);

export const RELATION_TYPES = ['CALLS', 'RENDERS', 'INSTANTIATES', 'REFERENCES'];
// Verb for the forward relation ("a renders b"); impact travels in reverse.
export const RELATION_VERBS = { CALLS: 'calls', RENDERS: 'renders', INSTANTIATES: 'constructs', REFERENCES: 'references' };
// Reads a path step backwards, matching the analyzer report: "OrderRow → rendered by OrderList".
export const STEP_LABELS = { CALLS: 'called by', RENDERS: 'rendered by', INSTANTIATES: 'constructed by', REFERENCES: 'referenced by' };
// One pair of entities can have several relation types; the edge is styled by the first in RELATION_TYPES.
export const edgeType = types => RELATION_TYPES.find(type => types.includes(type)) ?? 'CALLS';
export const edgeClass = type => `edge-${type.toLowerCase()}`;

export function prepareData(data) {
  const { graph } = data;
  if (data.evidence && (data.evidence.artifactKind !== 'graphentra-evidence' || !['2.0', '2.1'].includes(data.evidence.schemaVersion) || !['completed','no_changes','no_supported_changes','no_source_files'].includes(data.evidence.outcome))) throw new Error('Invalid evidence envelope.');
  if (graph?.schemaVersion !== '1.0' || !Array.isArray(graph.entities) || !Array.isArray(graph.relations)) {
    throw new Error('Unsupported technical graph. Regenerate it with the analyzer.');
  }
  const entities = new Map();
  for (const entity of graph.entities) {
    if (!entity || typeof entity.id !== 'string' || typeof entity.name !== 'string' || typeof entity.file !== 'string'
      || !Number.isInteger(entity.startLine) || !Number.isInteger(entity.endLine) || entities.has(entity.id)) {
      throw new Error('The graph contains invalid or duplicate entity identities. Regenerate it before visualizing.');
    }
    entities.set(entity.id, entity);
  }
  // One relation per entity pair; `types` lists every relation type between them.
  const relations = [];
  const calls = new Map();
  for (const relation of graph.relations) {
    if (!RELATION_TYPES.includes(relation?.type) || !entities.has(relation.from) || !entities.has(relation.to)) {
      throw new Error('The graph contains an invalid relationship.');
    }
    const key = edgeKey(relation.from, relation.to);
    if (!calls.has(key)) {
      const merged = { from: relation.from, to: relation.to, type: relation.type, types: [] };
      relations.push(merged);
      calls.set(key, merged);
    }
    const merged = calls.get(key);
    if (!merged.types.includes(relation.type)) merged.types.push(relation.type);
    merged.type = edgeType(merged.types);
  }
  const warnings = [...(data.warnings ?? [])];
  let analysis = data.analysis;
  const maxDepth = Number.isInteger(graph.capabilities?.maxBlastDepth) && graph.capabilities.maxBlastDepth >= 0
    ? graph.capabilities.maxBlastDepth : 6;
  if (analysis) {
    try {
      if (analysis.schemaVersion !== '1.1' || analysis.repository?.headSha !== graph.repository?.headSha
        || !Array.isArray(analysis.impacts) || !Array.isArray(analysis.changedEntities)) throw new Error();
      const seeds = new Set();
      for (const impact of analysis.impacts) {
        const seed = impact.changedEntity.id;
        if (!entities.has(seed) || seeds.has(seed) || typeof impact.change?.diff !== 'string') throw new Error();
        seeds.add(seed);
        for (const path of impact.blastRadius.paths) {
          const ids = path.path.map(entity => entity.id);
          if (ids[0] !== seed || ids.at(-1) !== path.target.id || path.depth !== ids.length - 1
            || path.depth < 1 || path.depth > maxDepth || new Set(ids).size !== ids.length
            || ids.some(id => !entities.has(id))
            || ids.slice(1).some((id, i) => !calls.has(edgeKey(id, ids[i])))
            || (path.stepTypes !== undefined && (!Array.isArray(path.stepTypes) || path.stepTypes.length !== path.depth
              || path.stepTypes.some((type, i) => !calls.get(edgeKey(ids[i + 1], ids[i])).types.includes(type))))) throw new Error();
        }
        const targets = new Set(impact.blastRadius.paths.map(path => path.target.id));
        if (!Array.isArray(impact.blastRadius.entities)
          || targets.size !== impact.blastRadius.totalAffectedEntities
          || impact.blastRadius.entities.length !== targets.size
          || impact.blastRadius.entities.some(entity => !targets.has(entity.id))) throw new Error();
      }
      if (analysis.changedEntities.length !== seeds.size || analysis.changedEntities.some(item => !seeds.has(item.entity.id))) throw new Error();
    } catch {
      if (data.evidence) throw new Error('Invalid recorded evidence. Regenerate it with the analyzer.');
      warnings.push('Saved analysis does not match the discovered graph or has invalid impact paths. It was ignored; only what-if exploration is available.');
      analysis = null;
    }
  }
  return { schemaVersion: data.evidence?.schemaVersion, graph, entities, relations, analysis, context: data.context, warnings, maxDepth, outcome: data.evidence?.outcome, diagnostics: data.evidence?.diagnostics ?? [], limitations: data.evidence?.limitations ?? [], provenance: data.evidence ? { comparison: data.evidence.comparison, sourceState: data.evidence.sourceState, options: data.evidence.options } : undefined };
}

// Recorded paths remain the authority; reverse traversal is only used in explicit what-if mode.
export function buildTraversal(model, seedIds, simulated = false) {
  const seeds = new Set(seedIds.filter(id => model.entities.has(id)));
  const depths = new Map([...seeds].map(id => [id, 0]));
  const edges = new Map();
  const paths = new Map();
  const addPath = ids => {
    ids.forEach((id, depth) => depths.set(id, Math.min(depths.get(id) ?? Infinity, depth)));
    const target = ids.at(-1);
    if (!paths.has(target)) paths.set(target, []);
    paths.get(target).push(ids);
    for (let i = 1; i < ids.length; i++) {
      const key = edgeKey(ids[i - 1], ids[i]);
      edges.set(key, Math.min(edges.get(key) ?? Infinity, i));
    }
  };
  if (simulated) {
    const callers = new Map();
    for (const { from, to } of model.relations) {
      if (!callers.has(to)) callers.set(to, []);
      callers.get(to).push(from);
    }
    const queue = [...seeds].map(id => [id]);
    const visited = new Set(seeds);
    for (let index = 0; index < queue.length; index++) {
      const path = queue[index];
      if (path.length - 1 >= model.maxDepth) continue;
      for (const id of callers.get(path.at(-1)) ?? []) {
        const depth = path.length;
        edges.set(edgeKey(path.at(-1), id), depth);
        if (visited.has(id)) continue;
        visited.add(id);
        const next = [...path, id];
        addPath(next);
        queue.push(next);
      }
    }
  } else {
    for (const impact of model.analysis?.impacts ?? []) {
      if (seeds.has(impact.changedEntity.id)) {
        for (const path of impact.blastRadius.paths) addPath(path.path.map(entity => entity.id));
      }
    }
  }
  return { seeds, depths, edges, paths, maxLayer: Math.max(0, ...depths.values(), ...edges.values()) };
}

// File positions never depend on the selected seed or playback layer.
export function layoutGraph(entities) {
  const files = new Map();
  for (const entity of entities.values()) {
    if (!files.has(entity.file)) files.set(entity.file, []);
    files.get(entity.file).push(entity);
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(files.size)));
  const positions = new Map();
  const groups = [];
  const rows = Array(columns).fill(32);
  [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).forEach(([file, members], index) => {
    const column = index % columns;
    const x = 32 + column * 350;
    const y = rows[column];
    members.sort((a, b) => a.startLine - b.startLine || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const height = 76 + members.length * 50;
    groups.push({ file, x, y, width: 310, height, members });
    members.forEach((entity, i) => positions.set(entity.id, { x: x + 24, y: y + 58 + i * 50, width: 262, height: 34 }));
    rows[column] += height + 40;
  });
  return { positions, groups, width: columns * 350 + 24, height: Math.max(200, ...rows) };
}
