import assert from 'node:assert/strict';
import { buildContextPack } from '../src/context-pack';
import type { ApplicationContextV2 } from '../src/context-contract';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository, collectBusinessSignals, listProjectFiles } from '@graphentra/analyzer';
import { buildLLMPayload, generateApplicationContextV2, refreshApplicationContext } from '../src/index';
import { createFakeLlm } from './helpers/fake-llm';
import { applyPaymentThresholdChange, createWebAppRepository } from './helpers/web-app';

const quiet = (t: { mock: { method: (object: object, name: string, fn: () => void) => void } }) => t.mock.method(console, 'info', () => {});

function setup(dir: string, engine: 'legacy' | 'extended', client: unknown) {
  const comparison = { mode: 'working-tree' as const };
  const result = analyzeRepository({ target: dir, comparison, engine });
  return {
    result,
    input: {
      technicalGraph: result.technicalGraph,
      applicationMap: result.applicationMap,
      signals: collectBusinessSignals({ projectRoot: dir, files: listProjectFiles({ target: dir, comparison }), technicalGraph: result.technicalGraph }),
      sourceFiles: result.technicalGraph.analyzedFiles.map(file => ({ path: file, content: fs.readFileSync(path.join(dir, file), 'utf8') })),
      options: { client: client as any, model: 'offline' },
      granularity: 'functions' as const,
    },
  };
}

test('extended (2.1) evidence: module entities are never described, kinds are sent, progress says entities', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const progress: string[] = [];
    const { result, input } = setup(repo.dir, 'extended', fake.client);
    assert.equal((result.evidence as { schemaVersion: string }).schemaVersion, '2.1');
    const modules = result.technicalGraph.entities.filter(entity => entity.kind === 'module');
    assert.ok(modules.length > 0, 'extended graph has synthetic module entities');
    const context = await generateApplicationContextV2({ ...input, onProgress: message => progress.push(message) });
    const described = fake.calls.filter(call => call.schema === 'graphentra_context_module').flatMap(call => call.user.entitiesToDescribe as any[]);
    assert.ok(described.length > 0);
    assert.ok(described.every(entity => typeof entity.kind === 'string' && entity.kind !== 'module'));
    const moduleIds = new Set(modules.map(entity => entity.id));
    assert.ok(context.entityAnnotations.every(annotation => !moduleIds.has(annotation.entityId)));
    const production = result.technicalGraph.entities.filter(entity => !entity.file.startsWith('e2e/') && entity.kind !== 'module');
    assert.equal(context.meta.coverage.eligibleEntities, production.length);
    assert.ok(progress.some(message => /^describing \d+ entities$/.test(message)));

    const progressRefresh: string[] = [];
    const { context: refreshed } = await refreshApplicationContext(context, { ...input, onProgress: message => progressRefresh.push(message) });
    assert.ok(progressRefresh.some(message => /^refreshing 0 new or changed entities$/.test(message)));
    assert.ok(refreshed.entityAnnotations.every(annotation => !moduleIds.has(annotation.entityId)));
  } finally { repo.cleanup(); }
});

test('legacy (2.0) evidence keeps its exact prompt payload, progress text and analysis scope', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const progress: string[] = [];
    const { result, input } = setup(repo.dir, 'legacy', fake.client);
    assert.equal((result.evidence as { schemaVersion: string }).schemaVersion, '2.0');
    const context = await generateApplicationContextV2({ ...input, onProgress: message => progress.push(message) });
    const described = fake.calls.filter(call => call.schema === 'graphentra_context_module').flatMap(call => call.user.entitiesToDescribe as any[]);
    assert.ok(described.every(entity => !('kind' in entity) && !('container' in entity)));
    assert.ok(progress.some(message => /^describing \d+ functions$/.test(message)));
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'legacy' });
    const payload = buildLLMPayload(changed.evidence.impacts, context, { capabilities: changed.evidence.technicalGraph.capabilities });
    assert.deepEqual(payload.analysisScope, {
      language: 'typescript', entityGranularity: 'function', relationTypes: ['CALLS'], maxBlastDepth: 6, changedFunctionCount: changed.evidence.impacts.length,
    });
  } finally { repo.cleanup(); }
});

test('extended (2.1) evidence: QA payload reports entity granularity and kinds, changed entities carry kind', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const { input } = setup(repo.dir, 'extended', fake.client);
    const context = await generateApplicationContextV2(input);
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'extended' });
    const payload = buildLLMPayload(changed.evidence.impacts, context, { capabilities: changed.evidence.technicalGraph.capabilities });
    assert.equal(payload.analysisScope.entityGranularity, 'entity');
    assert.deepEqual((payload.analysisScope as { entityKinds?: string[] }).entityKinds, ['component', 'function', 'method', 'module']);
    assert.deepEqual(payload.analysisScope.relationTypes, ['CALLS', 'INSTANTIATES', 'REFERENCES', 'RENDERS']);
    assert.ok(payload.changes.length > 0);
    assert.ok(payload.changes.every(change => typeof change.changedEntity.kind === 'string'));
  } finally { repo.cleanup(); }
});

const receiverContext = {
  schemaVersion: '2.0', meta: { coverage: {} },
  application: { name: 'app', summary: '', purpose: '', platform: '', userRoles: [] },
  features: [], surfaces: [],
  fileSummaries: [{ file: 'src/charts.ts', fingerprint: 'f', summary: 'Builds charts from pasted spreadsheet data.' }],
  glossary: [], entityAnnotations: [], rules: [], openQuestions: [], unknowns: [],
} as unknown as ApplicationContextV2;
const receiverEntity = (id: string) => ({ id, kind: 'function', name: id.split('#')[1], file: id.split('#')[0], startLine: 1, endLine: 2 });
const receiverImpact = (ids: string[]) => ({
  changedEntity: receiverEntity('src/clipboard.ts#read'), change: { file: 'src/clipboard.ts', diff: '' }, directDependents: [],
  blastRadius: { totalAffectedEntities: 0, entities: [], paths: [], truncated: false }, terminalDependents: [],
  receivesChangedValue: ids.map(id => ({ entity: receiverEntity(id), through: 'src/clipboard.ts#read' })),
}) as unknown as Parameters<typeof buildContextPack>[1][number];

test('context pack: receivers come with their meaning and through which code they get the value', () => {
  const pack = buildContextPack(receiverContext, [receiverImpact(['src/charts.ts#parse'])]);
  assert.deepEqual(pack.changes[0]!.receivesChangedValue, [
    { entityId: 'src/charts.ts#parse', receivedThrough: 'src/clipboard.ts#read', meaning: 'Part of src/charts.ts: Builds charts from pasted spreadsheet data.' },
  ]);
});

test('context pack: receivers rank specific code in another file above generic helpers and the same file', () => {
  const helper = 'src/utils.ts#arrayToMap';
  const relations = Array.from({ length: 6 }, (_, index) => ({ from: `src/a${index}.ts#f`, to: helper, type: 'CALLS' as const }));
  const pack = buildContextPack(receiverContext, [receiverImpact([helper, 'src/clipboard.ts#local', 'src/charts.ts#parse'])], { relations });
  assert.deepEqual(pack.changes[0]!.receivesChangedValue!.map(item => item.entityId), ['src/charts.ts#parse', 'src/clipboard.ts#local', helper]);
});

test('context pack: receivers are capped and the rest are reported as omitted', () => {
  const ids = Array.from({ length: 11 }, (_, index) => `src/m${String(index).padStart(2, '0')}.ts#f`);
  const pack = buildContextPack(receiverContext, [receiverImpact(ids)]);
  assert.equal(pack.changes[0]!.receivesChangedValue!.length, 8);
  assert.ok(pack.omitted.some(note => note.startsWith('3 code locations')));
});

test('context pack: a change with no receivers has no field', () => {
  assert.ok(!('receivesChangedValue' in buildContextPack(receiverContext, [receiverImpact([])]).changes[0]!));
});

test('context pack: a receiver relying on a removed character ranks first and says so in plain words', () => {
  const impact = receiverImpact(['src/a.ts#first', 'src/charts.ts#parse']);
  impact.receivesChangedValue![1] = { ...impact.receivesChangedValue![1]!, reliesOnRemovedCharacters: ['tab'] };
  const receivers = buildContextPack(receiverContext, [impact]).changes[0]!.receivesChangedValue!;
  assert.equal(receivers[0]!.entityId, 'src/charts.ts#parse');
  assert.equal(receivers[0]!.assumptionConflict, 'This code splits or searches its input on the tab character, which the changed code now removes before the value reaches it.');
  assert.ok(!('assumptionConflict' in receivers[1]!));
});
