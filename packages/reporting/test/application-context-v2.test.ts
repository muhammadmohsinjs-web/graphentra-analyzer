import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository, collectBusinessSignals, listProjectFiles, type TechnicalGraph } from '@graphentra/analyzer';
import {
  buildContextPack, formatImpactReport, generateApplicationContextV2, generateQAReport, loadApplicationContext,
  loadOrCreateApplicationContext, refreshApplicationContext, validateImpactReportSemantics, type ApplicationContext,
} from '../src/index';
import { createFakeLlm } from './helpers/fake-llm';
import { applyPaymentThresholdChange, createWebAppRepository } from './helpers/web-app';

const quiet = (t: { mock: { method: (object: object, name: string, fn: () => void) => void } }) => t.mock.method(console, 'info', () => {});

function onboardingInput(dir: string, client: unknown) {
  const comparison = { mode: 'working-tree' as const };
  const result = analyzeRepository({ target: dir, comparison });
  return {
    result,
    input: {
      technicalGraph: result.technicalGraph,
      applicationMap: result.applicationMap,
      signals: collectBusinessSignals({ projectRoot: dir, files: listProjectFiles({ target: dir, comparison }), technicalGraph: result.technicalGraph }),
      sourceFiles: result.technicalGraph.analyzedFiles.map(file => ({ path: file, content: fs.readFileSync(path.join(dir, file), 'utf8') })),
      options: { client: client as any, model: 'offline' },
    },
  };
}

test('v1 context is migrated in memory: facts link to entities and stale references never fail the report', () => {
  const graph = {
    schemaVersion: '1.0', repository: { targetPath: '.', headSha: 'abc', analyzerVersion: '0.4.0' },
    capabilities: { language: 'typescript', entityKinds: ['function'], relationTypes: ['CALLS'], maxBlastDepth: 6 },
    analyzedFiles: ['src/billing.ts'],
    entities: [{ id: 'src/billing.ts#chargeCard', kind: 'function', name: 'chargeCard', file: 'src/billing.ts', startLine: 1, endLine: 5 }],
    relations: [],
  } as TechnicalGraph;
  const legacy: ApplicationContext = {
    schemaVersion: '1.0', application: { name: 'Shop', summary: 'Shop', purpose: 'Sell' },
    domains: [{ id: 'billing', name: 'Billing', description: 'Payments' }],
    terminology: [{ term: 'cardToken', meaning: 'Saved card' }],
    entityAnnotations: [
      { entityId: 'src/billing.ts#chargeCard', businessMeaning: 'Charges a card.', domainIds: ['billing'], confidence: 'high' },
      { entityId: 'src/old.ts#renamed', businessMeaning: 'Gone.', domainIds: ['billing'], confidence: 'low' },
    ],
    applicationFacts: ['chargeCard returns false for amount <= 1.'],
    unknowns: [],
  };
  const { context, warnings } = loadApplicationContext(legacy, graph);
  assert.equal(context.schemaVersion, '2.0');
  assert.equal(context.meta.migratedFrom, '1.0');
  assert.deepEqual(context.entityAnnotations.map(item => item.entityId), ['src/billing.ts#chargeCard']);
  assert.deepEqual(context.rules[0]!.entityIds, ['src/billing.ts#chargeCard']);
  assert.deepEqual(context.glossary[0]!.identifiers, ['cardToken']);
  assert.ok(warnings.some(warning => /1 entity annotation/.test(warning)));
  assert.throws(() => loadApplicationContext({ schemaVersion: '99' }, graph), /Unsupported application context/);
});

test('staged onboarding describes every production function, features, and every surface', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm({ dropFirstModuleAnnotations: 1 });
    const progress: string[] = [];
    const { result, input } = onboardingInput(repo.dir, fake.client);
    const context = await generateApplicationContextV2({ ...input, onProgress: message => progress.push(message) });
    const production = result.technicalGraph.entities.filter(entity => !entity.file.startsWith('e2e/'));
    assert.equal(context.meta.coverage.annotatedEntities, production.length, 'coverage correction must fill the dropped annotation');
    assert.equal(context.meta.coverage.eligibleEntities, production.length);
    assert.ok(fake.calls.filter(call => call.schema === 'graphentra_context_module').length >= 2, 'one correction request expected');
    assert.equal(context.meta.coverage.describedSurfaces, result.applicationMap.surfaces.length);
    assert.equal(context.features[0]!.criticality, 'critical');
    assert.ok(context.entityAnnotations.every(annotation => annotation.fingerprint && annotation.featureIds.includes('checkout')));
    assert.ok(context.rules.some(rule => rule.entityIds.includes('src/server/orderService.ts#chargeCard')));
    const checkout = context.surfaces.find(surface => surface.surfaceId === 'ui:/checkout')!;
    assert.deepEqual(checkout.howToReach, ["Use the application's main navigation and select 'Your cart'", "Select 'Proceed to checkout'"]);
    // Module requests carry repository signals, not only source.
    const moduleUser = fake.calls.find(call => call.schema === 'graphentra_context_module')!.user;
    assert.ok(moduleUser.application.readme.includes('minimum order amount'));
    const synthesisUser = fake.calls.find(call => call.schema === 'graphentra_context_synthesis')!.user;
    assert.ok(synthesisUser.dataModels.some((model: string) => model.startsWith('Order(')));
    assert.ok(progress.some(message => /described surfaces/.test(message)));
  } finally { repo.cleanup(); }
});

test('context pack maps a backend change to its API, the pages that call it, navigation, rules, and old behaviour', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const context = await generateApplicationContextV2(onboardingInput(repo.dir, fake.client).input);
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const pack = buildContextPack(context, changed.impacts, { applicationMap: changed.applicationMap, relations: changed.technicalGraph.relations });
    const [change] = pack.changes;
    assert.equal(change!.changedEntityId, 'src/server/orderService.ts#chargeCard');
    assert.equal(change!.changedBehaviour!.describes, 'version-before-this-change');
    assert.equal(change!.features[0]!.criticality, 'critical');
    const api = change!.affectedAreas[0]!;
    assert.equal(api.surfaceId, 'api:POST /api/orders');
    assert.equal(api.access, 'Signed-in customers only');
    assert.deepEqual(api.usedByPages.map(page => page.surfaceId), ['ui:/checkout']);
    assert.match(api.usedByPages[0]!.howToReach.join(' '), /Proceed to checkout/);
    assert.equal(change!.rules[0]!.describes, 'version-before-this-change');
    assert.ok(pack.glossary.some(item => item.term === 'minimum order amount'));
    assert.ok(pack.allowedSurfaceIds.includes('ui:/checkout'));
    assert.ok(JSON.stringify(pack).length < 40_000);
  } finally { repo.cleanup(); }
});

test('QA report returns navigable test areas and rejects invented surfaces with one correction', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm({ inventSurfaceOnce: true });
    const context = await generateApplicationContextV2(onboardingInput(repo.dir, fake.client).input);
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const report = await generateQAReport(changed.evidence, context, { client: fake.client, model: 'offline' }, { applicationMap: changed.applicationMap });
    const qaCalls = fake.calls.filter(call => call.schema === 'qa_change_impact_report');
    assert.equal(qaCalls.length, 2, 'invented surface must trigger exactly one correction');
    assert.match(qaCalls[1]!.body.messages.at(-1).content, /unknown surface ui:\/invented/);
    const [area] = report.qaReport.testAreas!;
    assert.deepEqual(area!.surfaceIds, ['api:POST /api/orders', 'ui:/checkout']);
    assert.match(area!.howToReach, /Your cart.*Proceed to checkout/);
    assert.deepEqual(report.qaReport.qaChecks, area!.checks);
    assert.match(report.markdownReport, /Where and what to test:\n\n1\. POST \/api\/orders API\n {3}How to reach: /);
    assert.match(formatImpactReport(report.qaReport), /Setup: A signed-in customer with a cart totalling exactly 1\.00\./);
  } finally { repo.cleanup(); }
});

test('semantic validation allows user-visible routes but still rejects identifiers and file names', () => {
  const base = { summary: 'Checkout changed.', keyChanges: ['Payment rules changed.'], qaChecks: ['Verify payment.'], uncertainty: [] };
  const area = { area: 'Checkout page', surfaceIds: [], howToReach: 'Open /checkout or send POST /api/orders/:orderId', access: 'Customers', setup: 'A cart', checks: ['Verify /userProfile still loads.'] };
  assert.deepEqual(validateImpactReportSemantics({ ...base, testAreas: [area] }), []);
  const bad = validateImpactReportSemantics({ ...base, testAreas: [{ ...area, checks: ['Verify chargeCard in orderService.ts works.'] }] });
  assert.ok(bad.some(error => /technical entity identifiers/.test(error)));
});

test('refresh re-describes only changed functions, keeps reviewed knowledge, and backs up the previous file', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  const contextDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-refresh-'));
  try {
    const fake = createFakeLlm();
    const first = onboardingInput(repo.dir, fake.client);
    const generated = await loadOrCreateApplicationContext({
      contextDirectory, technicalGraph: first.input.technicalGraph, sourceFiles: first.input.sourceFiles, generateContext: true,
      applicationMap: first.input.applicationMap, signals: first.input.signals, llmOptions: first.input.options,
    });
    assert.equal(generated.action, 'generated');
    // A reviewer approves one annotation.
    const file = path.join(contextDirectory, 'application-context.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const reviewed = saved.entityAnnotations.find((item: any) => item.entityId === 'src/shared/pricing.ts#formatPrice');
    reviewed.basis = 'reviewed';
    reviewed.businessMeaning = 'Shows prices in US dollars with two decimals (approved by product).';
    fs.writeFileSync(file, JSON.stringify(saved));

    applyPaymentThresholdChange(repo.edit);
    repo.edit('src/shared/pricing.ts', 'toFixed(2)', 'toFixed(3)');
    const second = onboardingInput(repo.dir, fake.client);
    const before = fake.calls.length;
    const refreshed = await loadOrCreateApplicationContext({
      contextDirectory, technicalGraph: second.input.technicalGraph, sourceFiles: second.input.sourceFiles, refreshContext: true,
      applicationMap: second.input.applicationMap, signals: second.input.signals, llmOptions: second.input.options,
    });
    assert.equal(refreshed.action, 'refreshed');
    const described = fake.calls.slice(before).filter(call => call.schema === 'graphentra_context_module')
      .flatMap(call => call.user.entitiesToDescribe.map((entity: any) => entity.id));
    assert.deepEqual(described, ['src/server/orderService.ts#chargeCard']);
    assert.equal(refreshed.refreshSummary!.preservedReviewed, 1);
    const kept = refreshed.context.entityAnnotations.find(item => item.entityId === 'src/shared/pricing.ts#formatPrice')!;
    assert.match(kept.businessMeaning, /approved by product/);
    assert.equal(refreshed.context.entityAnnotations.find(item => item.entityId === 'src/server/orderService.ts#chargeCard')!.fingerprint,
      second.input.applicationMap.entityFingerprints['src/server/orderService.ts#chargeCard']);
    assert.ok(fs.existsSync(path.join(contextDirectory, 'application-context.previous.json')));
    assert.ok(refreshed.context.meta.refreshedAt);
  } finally { repo.cleanup(); fs.rmSync(contextDirectory, { recursive: true, force: true }); }
});

test('direct refresh API is a no-op when nothing changed', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const { input } = onboardingInput(repo.dir, fake.client);
    const context = await generateApplicationContextV2(input);
    const before = fake.calls.length;
    const { summary } = await refreshApplicationContext(context, input);
    assert.equal(fake.calls.length, before);
    assert.deepEqual(summary, { reannotatedEntities: 0, removedAnnotations: 0, addedSurfaces: 0, removedSurfaces: 0, preservedReviewed: 0 });
  } finally { repo.cleanup(); }
});
