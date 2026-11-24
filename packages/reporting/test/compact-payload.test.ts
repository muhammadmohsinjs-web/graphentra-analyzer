import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository, collectBusinessSignals, listProjectFiles, type Entity, type EntityImpact } from '@graphentra/analyzer';
import { buildLLMPayload, compactLLMPayload, expandCompactPayload, generateApplicationContextV2, qaInstruction } from '../src/index';
import { createFakeLlm } from './helpers/fake-llm';
import { applyPaymentThresholdChange, createWebAppRepository } from './helpers/web-app';

type Full = ReturnType<typeof buildLLMPayload>;

/** What a round trip must give back: the full payload minus `typedPath` (it restates path and stepTypes), with TypeScript as the default language. */
function normalized(payload: Full) {
  const entity = (e: Record<string, unknown>) => ({ language: 'typescript', ...e });
  return JSON.parse(JSON.stringify({
    ...payload,
    changes: payload.changes.map(c => ({
      ...c,
      changedEntity: entity(c.changedEntity),
      directDependents: c.directDependents.map(entity),
      blastRadius: { ...c.blastRadius, entities: c.blastRadius.entities.map(entity),
        paths: c.blastRadius.paths.map(({ typedPath: _t, ...p }: any) => ({ ...p, target: entity(p.target), path: p.path.map(entity) })) },
      productionDependents: c.productionDependents.map(entity),
      testDependents: c.testDependents.map(entity),
      terminalDependents: c.terminalDependents.map(entity),
    })),
  }), (_k, v) => v);
}

/** Deep equality that ignores key order (the compact form rebuilds objects in its own order). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
    return sameValue(ka, kb) && ka.every(k => sameValue((a as any)[k], (b as any)[k]));
  }
  return a === b;
}

const quiet = (t: { mock: { method: (object: object, name: string, fn: () => void) => void } }) => t.mock.method(console, 'info', () => {});

async function extendedPayload(t: Parameters<typeof quiet>[0]) {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const comparison = { mode: 'working-tree' as const };
    const base = analyzeRepository({ target: repo.dir, comparison, engine: 'extended' });
    const context = await generateApplicationContextV2({
      technicalGraph: base.technicalGraph, applicationMap: base.applicationMap,
      signals: collectBusinessSignals({ projectRoot: repo.dir, files: listProjectFiles({ target: repo.dir, comparison }), technicalGraph: base.technicalGraph }),
      sourceFiles: base.technicalGraph.analyzedFiles.map(file => ({ path: file, content: fs.readFileSync(path.join(repo.dir, file), 'utf8') })),
      options: { client: createFakeLlm().client as any, model: 'offline' }, granularity: 'functions',
    });
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison, engine: 'extended' });
    return buildLLMPayload(changed.evidence.impacts, context, { relations: changed.evidence.technicalGraph.relations, capabilities: changed.evidence.technicalGraph.capabilities });
  } finally { repo.cleanup(); }
}

test('R-2 round trip on real extended evidence: every entity, path and step type comes back', async t => {
  const full = await extendedPayload(t);
  assert.ok(full.changes.some(c => c.blastRadius.paths.some(p => p.stepTypes?.length)), 'fixture has typed paths');
  const compact = compactLLMPayload(full);
  assert.ok(sameValue(expandCompactPayload(compact), normalized(full)));
  // The compact form carries no full entity objects, no typedPath and no role copies.
  const text = JSON.stringify(compact);
  assert.doesNotMatch(text, /typedPath|productionDependents|testDependents|"startLine"/);
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(full)));
});

test('R-2 compact form is deterministic', async t => {
  const full = await extendedPayload(t);
  assert.equal(JSON.stringify(compactLLMPayload(full)), JSON.stringify(compactLLMPayload(structuredClone(full))));
});

// Synthetic cases where the analyzer's invariants do not hold: the encoder must keep what it cannot derive.
const e = (id: string, extra: Partial<Entity> = {}): Entity => {
  const [file, name] = id.split('#') as [string, string];
  return { id, kind: 'function', name: name.replace(/~\d+$/, ''), file, startLine: 1, endLine: 2, language: 'typescript', ...extra };
};
const changed = e('src/a.ts#changed', { exported: true, exportName: 'default' });
const caller = e('src/b.ts#Widget.render', { kind: 'method', container: 'Widget' });
const odd = e('src/c.ts#odd', { container: 'Other' });
const dotted = e('src/d.ts#a.b');
const js = e('src/e.js#legacy', { language: 'javascript' });
const twin = e('src/f.ts#twin~2');
const spaced = { ...e('src/g.ts#weird'), file: 'src/my file.ts' };
const testCaller = e('test/a.test.ts#spec');
const impact: EntityImpact = {
  changedEntity: changed,
  change: { file: 'src/a.ts', changedLines: [1], removedCode: ['old'], addedCode: ['new'], diff: '-old\n+new' },
  directDependents: [caller, testCaller],
  blastRadius: {
    totalAffectedEntities: 9, truncated: true, hubs: [{ entityId: 'src/hub.ts#hub', fanIn: 40, reach: 300 }],
    // Out of path order, so the list must be kept.
    entities: [odd, caller, dotted, js, twin, spaced, testCaller],
    paths: [
      { target: caller, depth: 1, path: [changed, caller], stepTypes: ['RENDERS'], confidence: 'likely', contractRisk: true },
      { target: odd, depth: 2, path: [changed, caller, odd], stepTypes: ['RENDERS', 'CALLS'], pathCount: 3 },
      { target: dotted, depth: 5, path: [changed, dotted] }, // depth does not match the path length
      { target: js, depth: 1, path: [caller, js] }, // does not start at the changed entity
      { target: twin, depth: 1, path: [changed, spaced] }, // target is not the last step
      { target: testCaller, depth: 1, path: [changed, testCaller] },
    ],
  },
  terminalDependents: [testCaller],
  confidence: 'likely',
  contractRisk: true,
};

test('R-2 round trip keeps every field the invariants cannot derive', () => {
  const context = {
    schemaVersion: '2.0',
    meta: { generatedAt: '2026-11-24T00:00:00.000Z', generator: { model: 'none', promptVersion: 'none' }, sourceHeadSha: '', analyzerVersion: '', unassignedFiles: [],
      coverage: { eligibleEntities: 0, annotatedEntities: 0, surfaces: 0, describedSurfaces: 0 } },
    application: { name: 'Demo', summary: '', purpose: '', platform: 'unknown', userRoles: [] },
    features: [], surfaces: [], fileSummaries: [], glossary: [], entityAnnotations: [], rules: [], openQuestions: [], unknowns: [],
  } as any;
  const full = buildLLMPayload([impact], context);
  assert.equal(full.changes[0]!.confidence, 'likely');
  assert.equal(full.changes[0]!.blastRadius.truncated, true);
  assert.deepEqual(full.changes[0]!.blastRadius.hubs, impact.blastRadius.hubs);
  const compact = compactLLMPayload(full);
  const change = compact.changes[0]!;
  assert.ok('entities' in change.blastRadius, 'out-of-order entity list is kept');
  assert.equal(compact.entities['src/a.ts#changed'], '1-2 function production exported as=default');
  assert.equal(compact.entities['src/c.ts#odd'], '1-2 function production in=Other');
  assert.equal(compact.entities['src/d.ts#a.b'], '1-2 function production in=-');
  assert.equal(compact.entities['src/e.js#legacy'], '1-2 function production javascript');
  assert.equal(compact.entities['src/f.ts#twin~2'], '1-2 function production');
  assert.equal(typeof compact.entities['src/g.ts#weird'], 'object');
  assert.deepEqual(change.blastRadius.paths[0], { path: ['src/b.ts#Widget.render'], stepTypes: ['RENDERS'], contractRisk: true, confidence: 'likely' });
  assert.ok(sameValue(expandCompactPayload(compact), normalized(full)));
});

test('R-2 the report instruction explains the compact encoding and no longer mentions typedPath', () => {
  assert.match(qaInstruction, /entities maps each entity ID/);
  assert.match(qaInstruction, /stepTypes\[i\] is how path\[i\] depends on the step before it/);
  assert.doesNotMatch(qaInstruction, /typedPath/);
});
