#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import {
  analyzeRepository, getBlastRadiusPaths, getBlastRadiusShortestPaths, MAX_BLAST_DEPTH,
  type EngineProfile, type Entity, type Relation, type TechnicalGraph,
} from '@graphentra/analyzer';

interface EdgeRow {
  repo: string;
  engine: EngineProfile;
  entities: number;
  edges: number;
  byType: Record<string, number>;
  maxFanIn: { id: string; callers: number } | null;
  hub: { id: string; affected: number; shortestMs: number; exhaustive: string } | null;
  analyzeMs: number;
  error?: string;
}

function parseArgs(argv: string[]) {
  const args = { repoDirs: [] as string[], timeoutMs: 20000, json: false, probe: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--exhaustive-timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--probe') args.probe = argv[++i];
    else args.repoDirs.push(path.resolve(arg));
  }
  if (args.repoDirs.length === 0) throw new Error('Usage: tsx tools/measure-edges.ts <repoDir>... [--exhaustive-timeout-ms N] [--json]');
  return args;
}

const git = (dir: string, gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function maps(graph: TechnicalGraph) {
  const entityById = new Map<string, Entity>(graph.entities.map(entity => [entity.id, entity]));
  const reverseAdjacency = new Map<string, Relation[]>();
  for (const relation of graph.relations) {
    const list = reverseAdjacency.get(relation.to) ?? [];
    list.push(relation);
    reverseAdjacency.set(relation.to, list);
  }
  return { entityById, reverseAdjacency };
}

function analyze(repoDir: string, engine: EngineProfile) {
  // The repo checkout must equal the head revision; the comparison range only needs to be valid for the graph.
  const head = git(repoDir, ['rev-parse', 'HEAD']);
  const base = git(repoDir, ['rev-parse', 'HEAD~1']);
  const started = process.hrtime.bigint();
  const result = analyzeRepository({ target: repoDir, comparison: { mode: 'commit', base, head }, engine });
  return { graph: result.technicalGraph, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/** Child-process mode: run the pre-P2-6 exhaustive simple-path enumeration for one entity and print the elapsed ms. */
function probe(repoDir: string, entityId: string) {
  const { graph } = analyze(repoDir, 'extended');
  const { entityById, reverseAdjacency } = maps(graph);
  const started = process.hrtime.bigint();
  const paths = getBlastRadiusPaths(entityId, reverseAdjacency, entityById, MAX_BLAST_DEPTH);
  console.log(JSON.stringify({ ms: Number(process.hrtime.bigint() - started) / 1e6, paths: paths.length }));
}

function measure(repoDir: string, engine: EngineProfile, timeoutMs: number): EdgeRow {
  const repo = path.basename(repoDir);
  try {
    const { graph, ms } = analyze(repoDir, engine);
    const byType: Record<string, number> = {};
    for (const relation of graph.relations) byType[relation.type] = (byType[relation.type] ?? 0) + 1;
    const { entityById, reverseAdjacency } = maps(graph);

    const callers = new Map<string, Set<string>>();
    for (const [to, relations] of reverseAdjacency) callers.set(to, new Set(relations.map(relation => relation.from)));
    let maxFanIn: EdgeRow['maxFanIn'] = null;
    for (const [id, set] of [...callers].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!maxFanIn || set.size > maxFanIn.callers) maxFanIn = { id, callers: set.size };
    }

    // Hub = the entity with the largest blast radius (shortest-path reachable set), found with the bounded P2-6 search.
    let hub: EdgeRow['hub'] = null;
    for (const id of [...entityById.keys()].sort()) {
      if (!callers.has(id)) continue;
      const started = process.hrtime.bigint();
      const { paths } = getBlastRadiusShortestPaths(id, reverseAdjacency, entityById, MAX_BLAST_DEPTH);
      const shortestMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (!hub || paths.length > hub.affected) hub = { id, affected: paths.length, shortestMs, exhaustive: 'not run' };
    }
    if (hub && engine === 'extended') {
      const run = spawnSync(process.execPath, [...process.execArgv, process.argv[1], repoDir, '--probe', hub.id],
        { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 26 });
      if (run.error || run.status !== 0) hub.exhaustive = `>${timeoutMs / 1000}s (timeout or out of memory)`;
      else { const out = JSON.parse(run.stdout.trim().split('\n').pop()!); hub.exhaustive = `${out.ms.toFixed(0)} ms, ${out.paths} paths`; }
    }
    return { repo, engine, entities: graph.entities.length, edges: graph.relations.length, byType, maxFanIn, hub, analyzeMs: Math.round(ms) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { repo, engine, entities: 0, edges: 0, byType: {}, maxFanIn: null, hub: null, analyzeMs: 0,
      error: typeof code === 'string' ? code : error instanceof Error ? error.constructor.name : 'UnknownError' };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.probe) return probe(args.repoDirs[0], args.probe);
  const rows: EdgeRow[] = [];
  for (const repoDir of args.repoDirs) for (const engine of ['legacy', 'extended'] as const) rows.push(measure(repoDir, engine, args.timeoutMs));
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  console.log(['repo', 'engine', 'entities', 'edges', 'CALLS', 'RENDERS', 'REFERENCES', 'INSTANTIATES', 'analyzeMs', 'maxFanIn', 'hubAffected', 'hubShortestMs', 'hubExhaustive'].join('\t'));
  for (const r of rows) {
    console.log(r.error ? [r.repo, r.engine, `error:${r.error}`].join('\t') : [
      r.repo, r.engine, r.entities, r.edges,
      r.byType.CALLS ?? 0, r.byType.RENDERS ?? 0, r.byType.REFERENCES ?? 0, r.byType.INSTANTIATES ?? 0,
      r.analyzeMs, r.maxFanIn ? `${r.maxFanIn.callers} (${r.maxFanIn.id})` : '-',
      r.hub?.affected ?? '-', r.hub ? r.hub.shortestMs.toFixed(1) : '-', r.hub?.exhaustive ?? '-',
    ].join('\t'));
  }
}

main();
