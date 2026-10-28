import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepository, extractBaseGraph } from '../src/analyze';
import type { Entity } from '../src/contracts';
import { createRepositoryContext } from '../src/repository';
import { captureSourceSnapshot } from '../src/source-snapshot';
import { extractTechnicalGraph } from '../src/technical-graph';
import { createRepo } from './helpers/git-fixture';

const relationKeys = (relations: Array<{ from: string; type: string; to: string }>) =>
  relations.map(relation => `${relation.from}|${relation.type}|${relation.to}`).sort();

function extractHead(target: string, comparison: Parameters<typeof createRepositoryContext>[1]) {
  const repo = createRepositoryContext(target, comparison);
  const snapshot = captureSourceSnapshot(repo, 'extended');
  const graph = extractTechnicalGraph({
    files: snapshot.files, compilerOptions: snapshot.compilerOptions, host: snapshot.host, projectRoot: repo.projectRoot,
    headSha: repo.sourceState.checkoutSha, targetPath: repo.projectInsideRepository, excludePaths: repo.excludePaths, engine: 'extended',
  });
  for (const entity of graph.entities) entity.language ??= 'typescript';
  return { repo, snapshot, graph };
}

test('unchanged repo: base and head graphs have the same entities and relations', () => {
  const repo = createRepo();
  try {
    repo.commitFile('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    repo.commitFile('util.ts', 'export function helper() { return 1; }\nexport class Box { open() { return helper(); } }');
    repo.commitFile('main.ts', "import { helper, Box } from './util';\nexport function run() { return helper() + new Box().open(); }");
    repo.commitFile('legacy.js', 'function old() { return 1; }\nfunction caller() { return old(); }\nmodule.exports = { caller };');
    const { repo: ctx, graph: head } = extractHead(repo.dir, { mode: 'working-tree' });
    const { graph: base, diagnostics } = extractBaseGraph(ctx, 'extended', { headCompilerOptions: {} });
    assert.ok(head.entities.length >= 4);
    assert.deepEqual(base.entities.map(entity => entity.id).sort(), head.entities.map(entity => entity.id).sort());
    assert.deepEqual(relationKeys(base.relations), relationKeys(head.relations));
    assert.ok(relationKeys(base.relations).length > 0);
    assert.deepEqual([...base.parentById].sort(), [...head.parentById].sort());
    assert.equal(diagnostics.some(item => item.code === 'BASELINE_CONFIG_FALLBACK'), false);
    assert.equal(base.program, undefined);
    assert.equal(base.checker, undefined);
    assert.equal(base.symbolToEntity, undefined);
  } finally { repo.cleanup(); }
});

test('contentIdentity is unaffected by base extraction', () => {
  const repo = createRepo();
  try {
    repo.commitFile('a.ts', 'export function kept() { return 1; }\nexport function removed() { return kept(); }');
    const baseSha = repo.commitFile('b.ts', 'export function other() { return 2; }');
    repo.commitFile('a.ts', 'export function kept() { return 3; }');
    const comparison = { mode: 'commit' as const, base: baseSha, head: 'HEAD' };
    const result = analyzeRepository({ target: repo.dir, comparison });
    assert.ok(result.changedEntities.length > 0);

    // Same pipeline as analyzeRepository, without the base step.
    const { snapshot } = extractHead(repo.dir, comparison);
    assert.equal(result.evidence.sourceState.contentIdentity, snapshot.identity());

    // Running base extraction against a live snapshot's repo leaves its identity untouched too.
    const { repo: ctx, snapshot: live } = extractHead(repo.dir, comparison);
    const before = live.identity();
    const { graph } = extractBaseGraph(ctx, 'extended', { headCompilerOptions: live.compilerOptions });
    assert.ok(graph.entities.some(entity => entity.name === 'removed'));
    assert.equal(live.identity(), before);
    assert.equal(live.identity(), result.evidence.sourceState.contentIdentity);
  } finally { repo.cleanup(); }
});

test('commit mode: a function deleted in head is still in the base graph', () => {
  const repo = createRepo();
  try {
    repo.commitFile('lib.ts', 'export function gone() { return 1; }\nexport function stays() { return gone(); }');
    const baseSha = repo.commitFile('app.ts', "import { stays } from './lib';\nexport function app() { return stays(); }");
    repo.commitFile('lib.ts', 'export function stays() { return 2; }');
    const { repo: ctx, graph: head } = extractHead(repo.dir, { mode: 'commit', base: baseSha, head: 'HEAD' });
    const { graph: base } = extractBaseGraph(ctx, 'extended', { headCompilerOptions: {} });
    const gone = base.entities.find(entity => entity.name === 'gone');
    assert.ok(gone);
    assert.equal(head.entities.some(entity => entity.name === 'gone'), false);
    assert.equal(base.relations.some(relation => relation.to === gone.id && relation.type === 'CALLS'), true);
    assert.equal(base.reverseAdjacency.get(gone.id)?.length, 1);
    assert.equal(base.entityById.get(gone.id), gone);
  } finally { repo.cleanup(); }
});

test('base tsconfig missing: falls back to head options with an info diagnostic', () => {
  const repo = createRepo();
  try {
    const baseSha = repo.commitFile('a.ts', 'export function a() { return 1; }');
    repo.commitFile('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    repo.commitFile('a.ts', 'export function a() { return 2; }');
    const { repo: ctx, snapshot } = extractHead(repo.dir, { mode: 'commit', base: baseSha, head: 'HEAD' });
    const { graph, diagnostics } = extractBaseGraph(ctx, 'extended', { headCompilerOptions: snapshot.compilerOptions });
    const fallback = diagnostics.filter(item => item.code === 'BASELINE_CONFIG_FALLBACK');
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].severity, 'info');
    assert.ok(graph.entities.some((entity: Entity) => entity.name === 'a'));
  } finally { repo.cleanup(); }
});

test('base tsconfig unparseable: falls back without throwing', () => {
  const repo = createRepo();
  try {
    const baseSha = repo.commitFile('tsconfig.json', '{ not json');
    repo.commitFile('a.ts', 'export function a() { return 1; }');
    repo.commitFile('tsconfig.json', '{}');
    const { repo: ctx, snapshot } = extractHead(repo.dir, { mode: 'commit', base: baseSha, head: 'HEAD' });
    const { diagnostics } = extractBaseGraph(ctx, 'extended', { headCompilerOptions: snapshot.compilerOptions });
    assert.equal(diagnostics.filter(item => item.code === 'BASELINE_CONFIG_FALLBACK').length, 1);
  } finally { repo.cleanup(); }
});

test('onEntityNode is called once per entity with its declaration node', () => {
  const repo = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() { return b(); }\nfunction b() { return 1; }');
    const { repo: ctx } = extractHead(repo.dir, { mode: 'working-tree' });
    const seen: string[] = [];
    const { graph } = extractBaseGraph(ctx, 'extended', { headCompilerOptions: {},
      onEntityNode: (entity, node, sourceFile) => { assert.equal(node.getSourceFile(), sourceFile); seen.push(entity.id); } });
    assert.deepEqual(seen.sort(), graph.entities.map(entity => entity.id).sort());
  } finally { repo.cleanup(); }
});
