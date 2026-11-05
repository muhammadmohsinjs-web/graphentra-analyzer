#!/usr/bin/env node
// Renders an evidence.json as a zoomable canvas graph in a self-contained HTML page.
//
//   node tools/visualize-evidence.mjs /absolute/path/to/evidence.json [--out page.html] [--no-open]
//
// The layout is a pure function of the evidence: no randomness, no clock, no text
// measurement. The same evidence at the same path always yields the same bytes.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER_H = 26;
const ROW_H = 22;
const CARD_PAD = 6;
const CHAR_W = 7.3;
const CARD_MIN_W = 220;
const CARD_MAX_W = 420;
const CARD_GAP = 28;
const SUBCOLUMN_GAP = 56;
const LAYER_GAP = 170;
const SECTION_GAP = 140;
const SWEEPS = 6;

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function usage() {
  return 'Usage: node tools/visualize-evidence.mjs <path to evidence.json> [--out <page.html>] [--no-open]';
}

function parseArgs(argv) {
  const options = { input: undefined, out: undefined, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-open') options.open = false;
    else if (arg === '--out') {
      options.out = argv[(i += 1)];
      if (!options.out) throw new Error('--out needs a file path.');
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    else if (options.input) throw new Error(`Expected one evidence file, got a second: ${arg}.`);
    else options.input = arg;
  }
  if (!options.input) throw new Error('No evidence file given.');
  return options;
}

function readEvidence(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (evidence?.artifactKind !== 'graphentra-evidence') {
    throw new Error(`${file} is not a Graphentra evidence file (artifactKind is ${JSON.stringify(evidence?.artifactKind)}).`);
  }
  const graph = evidence.technicalGraph;
  if (!Array.isArray(graph?.entities) || !Array.isArray(graph?.relations)) {
    throw new Error(`${file} has no technicalGraph.entities and technicalGraph.relations.`);
  }
  return evidence;
}

/** Joins the graph with the change and impact sections into one node and edge list. */
function buildModel(evidence, evidencePath) {
  const graph = evidence.technicalGraph;
  const changedEntities = evidence.changedEntities ?? [];
  const impacts = evidence.impacts ?? [];
  const byId = new Map();

  const ensure = (entity, inGraph) => {
    let node = byId.get(entity.id);
    if (!node) {
      node = {
        id: entity.id,
        name: entity.name ?? entity.id,
        kind: entity.kind ?? 'unknown',
        file: entity.file ?? '(unknown file)',
        startLine: entity.startLine ?? 0,
        endLine: entity.endLine ?? entity.startLine ?? 0,
        exported: entity.exported === true,
        // Deleted entities exist only in the change section, not in the current graph.
        ghost: !inGraph,
        changed: false,
        affected: false,
        direct: false,
        depth: null,
        confidence: null,
        path: null,
        reachedFrom: new Set(),
      };
      byId.set(entity.id, node);
    }
    return node;
  };

  for (const entity of graph.entities) ensure(entity, true);
  for (const change of changedEntities) {
    const node = ensure(change.entity, false);
    node.changed = true;
    node.changeKind = change.changeKind;
    node.changeClasses = change.changeClasses ?? [];
    node.changedLines = change.change?.changedLines ?? [];
  }

  const impactPairs = new Map();
  let truncated = false;
  for (const impact of impacts) {
    const source = impact.changedEntity;
    const sourceNode = ensure(source, false);
    sourceNode.changed = true;
    const blast = impact.blastRadius ?? { entities: [], paths: [], totalAffectedEntities: 0 };
    sourceNode.blastCount = blast.totalAffectedEntities ?? blast.entities.length;
    sourceNode.impactConfidence = impact.confidence;
    if (blast.truncated === true || (blast.totalAffectedEntities ?? 0) > blast.entities.length) truncated = true;

    for (const entity of blast.entities ?? []) {
      const node = ensure(entity, false);
      node.affected = true;
      node.reachedFrom.add(source.id);
    }
    for (const entity of impact.directDependents ?? []) {
      const node = ensure(entity, false);
      node.affected = true;
      node.direct = true;
      node.reachedFrom.add(source.id);
    }
    for (const route of blast.paths ?? []) {
      const ids = route.path.map((entity) => ensure(entity, false).id);
      ids.forEach((id, step) => {
        if (step === 0) return;
        // Impact runs from a dependency to its dependent, so the relation is the reverse step.
        const key = `${id}\0${ids[step - 1]}`;
        if (!impactPairs.has(key)) impactPairs.set(key, { from: id, to: ids[step - 1], type: route.stepTypes?.[step - 1] ?? 'CALLS' });
      });
      if (!route.target) continue;
      const node = ensure(route.target, false);
      const candidate = { source: source.id, ids, types: route.stepTypes ?? [] };
      const isCloser = node.depth === null || route.depth < node.depth;
      const isSameDepthEarlier = route.depth === node.depth && node.path && compareStrings(source.id, node.path.source) < 0;
      if (isCloser || isSameDepthEarlier) {
        node.depth = route.depth;
        node.path = candidate;
      }
      if (route.confidence === 'proven' || node.confidence === null) {
        node.confidence = route.confidence ?? node.confidence;
      }
    }
  }

  const nodes = [...byId.values()].sort(
    (a, b) => compareStrings(a.file, b.file) || a.startLine - b.startLine || compareStrings(a.id, b.id),
  );
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));

  const relationKey = (from, to, type) => `${from}\0${to}\0${type}`;
  const relationKeys = new Set();
  const pairsWithRelation = new Set();
  const edges = [];
  for (const relation of graph.relations) {
    if (!byId.has(relation.from) || !byId.has(relation.to)) continue;
    const key = relationKey(relation.from, relation.to, relation.type);
    if (relationKeys.has(key)) continue;
    relationKeys.add(key);
    const pair = `${relation.from}\0${relation.to}`;
    pairsWithRelation.add(pair);
    edges.push({ from: relation.from, to: relation.to, type: relation.type, confidence: relation.confidence ?? null, impact: impactPairs.has(pair) });
  }
  // A path can step through a deleted entity, whose relations are gone from the graph.
  for (const [pair, step] of impactPairs) {
    if (!pairsWithRelation.has(pair)) edges.push({ from: step.from, to: step.to, type: step.type, confidence: null, impact: true, inferred: true });
  }
  edges.sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.type, b.type),
  );

  const types = [...new Set(edges.map((edge) => edge.type))].sort(compareStrings);
  const impactIndexes = nodes.flatMap((node, index) => (node.changed || node.affected ? [index] : []));
  const compactEdges = edges.map((edge) => ({ a: indexOf.get(edge.from), b: indexOf.get(edge.to) }));
  const impactSet = new Set(impactIndexes);
  const impactEdges = compactEdges.filter((edge) => impactSet.has(edge.a) && impactSet.has(edge.b));

  return {
    meta: {
      evidencePath,
      target: evidence.target?.targetPath ?? '',
      schemaVersion: evidence.schemaVersion,
      analyzerVersion: evidence.analyzerVersion,
      outcome: evidence.outcome,
      comparison: evidence.comparison ?? null,
      generatedAt: graph.repository?.generatedAt ?? null,
    },
    stats: buildStats(evidence, nodes, edges, truncated),
    types,
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      file: node.file,
      startLine: node.startLine,
      endLine: node.endLine,
      exported: node.exported,
      ghost: node.ghost,
      changed: node.changed,
      affected: node.affected,
      direct: node.direct,
      depth: node.depth,
      confidence: node.confidence,
      changeKind: node.changeKind ?? null,
      changeClasses: node.changeClasses ?? [],
      changedLines: node.changedLines ?? [],
      blastCount: node.blastCount ?? null,
      impactConfidence: node.impactConfidence ?? null,
      reachedFrom: [...node.reachedFrom].map((id) => indexOf.get(id)).sort((a, b) => a - b),
      path: node.path
        ? { ids: node.path.ids.map((id) => indexOf.get(id)), types: node.path.types }
        : null,
    })),
    edges: edges.map((edge) => [
      indexOf.get(edge.from),
      indexOf.get(edge.to),
      types.indexOf(edge.type),
      edge.impact ? 1 : 0,
      edge.confidence,
      edge.inferred ? 1 : 0,
    ]),
    frontier: (evidence.frontier ?? []).map((site) => ({
      node: indexOf.get(site.entityId) ?? null,
      file: site.file,
      line: site.line,
      reason: site.reason,
    })),
    limitations: evidence.limitations ?? [],
    views: {
      full: layoutGraph(nodes.map((_, index) => index), compactEdges, nodes),
      impact: layoutGraph(impactIndexes, impactEdges, nodes),
    },
  };
}

function tally(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareStrings(a, b)));
}

function buildStats(evidence, nodes, edges, truncated) {
  const changed = nodes.filter((node) => node.changed);
  // A changed entity that another change also reaches still counts once, as changed.
  const affected = nodes.filter((node) => node.affected && !node.changed);
  const direct = affected.filter((node) => node.direct || node.depth === 1);
  const lines = (evidence.coverage?.byLanguage ?? []).reduce(
    (sum, row) => ({ changed: sum.changed + (row.changedLines ?? 0), attributed: sum.attributed + (row.attributedLines ?? 0) }),
    { changed: 0, attributed: 0 },
  );
  const inGraph = nodes.filter((node) => !node.ghost).length;
  const frontierSites = (evidence.frontier ?? []).length;

  const warnings = [];
  if (truncated) warnings.push('The analyzer truncated at least one blast radius, so the affected count is a lower bound.');
  if (frontierSites > 0) warnings.push(`${frontierSites} dynamic call site(s) could not be resolved, so more entities may be affected than shown.`);
  const ghosts = nodes.filter((node) => node.ghost).length;
  if (ghosts > 0) warnings.push(`${ghosts} entity(ies) are in the change or impact sections but not in the current graph, usually because they were deleted. They are drawn with a dashed outline.`);

  return {
    entities: inGraph,
    relations: edges.filter((edge) => !edge.inferred).length,
    files: new Set(nodes.filter((node) => !node.ghost).map((node) => node.file)).size,
    changedEntities: changed.length,
    affectedEntities: affected.length,
    directAffected: direct.length,
    transitiveAffected: affected.length - direct.length,
    changedFiles: (evidence.changedFiles ?? []).length,
    affectedFiles: new Set(affected.map((node) => node.file)).size,
    changedAlsoReached: changed.filter((node) => node.affected).length,
    impactShare: inGraph === 0 ? 0 : (changed.length + affected.length) / inGraph,
    maxBlastDepth: evidence.technicalGraph.capabilities?.maxBlastDepth ?? null,
    affectedByDepth: tally(affected.filter((node) => node.depth !== null), (node) => node.depth),
    affectedByKind: tally(affected, (node) => node.kind),
    affectedByConfidence: tally(affected.filter((node) => node.confidence), (node) => node.confidence),
    changedByKind: tally(changed, (node) => node.changeKind ?? 'unknown'),
    frontierSites,
    skippedEntities: (evidence.skippedEntities ?? []).length,
    changedLines: lines.changed,
    attributedLines: lines.attributed,
    warnings,
  };
}

/** Tarjan on the file graph. Components come out with dependencies before dependents. */
function stronglyConnected(count, successors) {
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const component = new Int32Array(count).fill(-1);
  const stack = [];
  let nextIndex = 0;
  let nextComponent = 0;

  for (let root = 0; root < count; root += 1) {
    if (index[root] !== -1) continue;
    const work = [[root, 0]];
    index[root] = low[root] = nextIndex++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame[0];
      if (frame[1] < successors[node].length) {
        const next = successors[node][frame[1]++];
        if (index[next] === -1) {
          index[next] = low[next] = nextIndex++;
          stack.push(next);
          onStack[next] = 1;
          work.push([next, 0]);
        } else if (onStack[next]) {
          low[node] = Math.min(low[node], index[next]);
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          low[parent] = Math.min(low[parent], low[node]);
        }
        if (low[node] === index[node]) {
          let member;
          do {
            member = stack.pop();
            onStack[member] = 0;
            component[member] = nextComponent;
          } while (member !== node);
          nextComponent += 1;
        }
      }
    }
  }
  return { component, componentCount: nextComponent };
}

/**
 * Layered layout. Each source file is a card holding its entities in line order. Files
 * are layered by their dependencies, so a relation points left to right unless it is
 * part of a cycle between files.
 */
function layoutGraph(nodeIndexes, edges, nodes) {
  const rowsByFile = new Map();
  for (const index of nodeIndexes) {
    const file = nodes[index].file;
    if (!rowsByFile.has(file)) rowsByFile.set(file, []);
    rowsByFile.get(file).push(index);
  }
  const files = [...rowsByFile.keys()].sort(compareStrings);
  if (files.length === 0) return { cards: [] };
  const fileIndex = new Map(files.map((file, index) => [file, index]));

  const out = files.map(() => new Set());
  const into = files.map(() => new Set());
  for (const edge of edges) {
    const from = fileIndex.get(nodes[edge.a].file);
    const to = fileIndex.get(nodes[edge.b].file);
    if (from === to) continue;
    out[from].add(to);
    into[to].add(from);
  }
  const successors = out.map((set) => [...set].sort((a, b) => a - b));
  const connected = files.map((_, index) => out[index].size + into[index].size > 0);

  const { component, componentCount } = stronglyConnected(files.length, successors);
  const membersOf = Array.from({ length: componentCount }, () => []);
  files.forEach((_, index) => membersOf[component[index]].push(index));
  const componentLayer = new Int32Array(componentCount);
  for (let c = componentCount - 1; c >= 0; c -= 1) {
    for (const member of membersOf[c]) {
      for (const next of successors[member]) {
        const target = component[next];
        if (target !== c) componentLayer[target] = Math.max(componentLayer[target], componentLayer[c] + 1);
      }
    }
  }

  const layers = [];
  files.forEach((_, index) => {
    if (!connected[index]) return;
    const layer = componentLayer[component[index]];
    (layers[layer] ??= []).push(index);
  });
  const orderedLayers = layers.filter(Boolean);
  orderLayers(orderedLayers, out, into);

  const cardOf = files.map((file) => {
    const rows = rowsByFile.get(file);
    const longest = rows.reduce((max, index) => Math.max(max, nodes[index].name.length), 0);
    return {
      file,
      w: Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(longest * CHAR_W) + 68)),
      h: HEADER_H + rows.length * ROW_H + CARD_PAD,
      nodes: rows,
    };
  });

  const area = cardOf.reduce((sum, card, index) => sum + (connected[index] ? (card.h + CARD_GAP) * (card.w + SUBCOLUMN_GAP) : 0), 0);
  const tallest = cardOf.reduce((max, card) => Math.max(max, card.h), 0);
  const targetHeight = Math.max(tallest, Math.ceil(Math.sqrt(area * 0.62)));

  const cards = [];
  let x = 0;
  for (const layer of orderedLayers) {
    const columns = [[]];
    let height = 0;
    for (const index of layer) {
      const card = cardOf[index];
      if (height > 0 && height + card.h > targetHeight) {
        columns.push([]);
        height = 0;
      }
      columns[columns.length - 1].push(card);
      height += card.h + CARD_GAP;
    }
    for (const column of columns) {
      const width = column.reduce((max, card) => Math.max(max, card.w), 0);
      const columnHeight = column.reduce((sum, card) => sum + card.h + CARD_GAP, -CARD_GAP);
      let y = Math.round((targetHeight - columnHeight) / 2);
      for (const card of column) {
        cards.push({ file: card.file, x, y, w: width, h: card.h, nodes: card.nodes });
        y += card.h + CARD_GAP;
      }
      x += width + SUBCOLUMN_GAP;
    }
    x += LAYER_GAP - SUBCOLUMN_GAP;
  }

  // Files with no cross-file relation sit on shelves below the layered part.
  const shelfWidth = Math.max(x - LAYER_GAP, 1400);
  let shelfX = 0;
  let shelfY = cards.length > 0 ? targetHeight + SECTION_GAP : 0;
  let shelfHeight = 0;
  files.forEach((_, index) => {
    if (connected[index]) return;
    const card = cardOf[index];
    if (shelfX > 0 && shelfX + card.w > shelfWidth) {
      shelfX = 0;
      shelfY += shelfHeight + CARD_GAP;
      shelfHeight = 0;
    }
    cards.push({ file: card.file, x: shelfX, y: shelfY, w: card.w, h: card.h, nodes: card.nodes });
    shelfX += card.w + CARD_GAP;
    shelfHeight = Math.max(shelfHeight, card.h);
  });

  return { cards };
}

/** Barycenter crossing reduction with a fixed sweep count and a total tie-break. */
function orderLayers(layers, out, into) {
  const rank = new Float64Array(out.length);
  const assignRanks = (layer) => layer.forEach((file, position) => {
    rank[file] = (position + 0.5) / layer.length;
  });
  layers.forEach(assignRanks);

  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const sequence = sweep % 2 === 0 ? layers : [...layers].reverse();
    for (const layer of sequence) {
      const inLayer = new Set(layer);
      const score = new Map();
      for (const file of layer) {
        let sum = 0;
        let count = 0;
        for (const neighbour of [...out[file], ...into[file]]) {
          if (inLayer.has(neighbour)) continue;
          sum += rank[neighbour];
          count += 1;
        }
        score.set(file, count === 0 ? rank[file] : sum / count);
      }
      layer.sort((a, b) => score.get(a) - score.get(b) || rank[a] - rank[b] || a - b);
      assignRanks(layer);
    }
  }
}

function renderPage(model) {
  const templatePath = fileURLToPath(new URL('./evidence-graph-viewer.html', import.meta.url));
  const template = readFileSync(templatePath, 'utf8');
  const payload = JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replaceAll(String.fromCharCode(0x2028), '\\u2028')
    .replaceAll(String.fromCharCode(0x2029), '\\u2029');
  return template.split('__EVIDENCE_PAYLOAD__').join(payload);
}

function openInBrowser(file) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : ['xdg-open', [file]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Could not open a browser. Open the file above yourself.'));
  child.unref();
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    process.exit(2);
  }

  try {
    const evidencePath = path.resolve(options.input);
    const model = buildModel(readEvidence(evidencePath), evidencePath);
    const page = renderPage(model);
    const pathHash = createHash('sha256').update(evidencePath).digest('hex').slice(0, 12);
    const out = path.resolve(options.out ?? path.join(os.tmpdir(), `graphentra-evidence-${pathHash}.html`));
    writeFileSync(out, page);

    const { stats } = model;
    console.log(`Evidence:  ${evidencePath}`);
    console.log(`Graph:     ${stats.entities} entities, ${stats.relations} relations, ${stats.files} files`);
    console.log(`Changed:   ${stats.changedEntities} entities, ${stats.changedFiles} changed files`);
    console.log(`Affected:  ${stats.affectedEntities} entities (${stats.directAffected} direct, ${stats.transitiveAffected} transitive) in ${stats.affectedFiles} files`);
    for (const warning of stats.warnings) console.log(`Note:      ${warning}`);
    console.log(`Page:      ${out}`);
    if (options.open) openInBrowser(out);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
