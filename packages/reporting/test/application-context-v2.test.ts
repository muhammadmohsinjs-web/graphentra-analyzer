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
  const result = analyzeRepository({ target: dir, comparison, engine: 'legacy' });
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

test('onboarding retries once when the model returns truncated JSON', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm({ malformedOnce: 'graphentra_context_synthesis' });
    const context = await generateApplicationContextV2(onboardingInput(repo.dir, fake.client).input);
    assert.equal(fake.calls.filter(call => call.schema === 'graphentra_context_synthesis').length, 2);
    assert.equal(context.features[0]!.criticality, 'critical');
  } finally { repo.cleanup(); }
});

test('an interrupted onboarding resumes from saved requests, and the lifecycle removes them once written', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const checkpointDir = path.join(repo.dir, '.graphentra', 'context-batches');
    const first = createFakeLlm();
    const { input } = onboardingInput(repo.dir, first.client);
    const original = await generateApplicationContextV2({ ...input, checkpointDir });
    assert.ok(first.calls.length > 0);
    assert.equal(fs.readdirSync(checkpointDir).length, first.calls.length);

    const second = createFakeLlm();
    const resumed = await generateApplicationContextV2({ ...input, options: { client: second.client as any, model: 'offline' }, checkpointDir });
    assert.equal(second.calls.length, 0, 'every request is served from the saved results');
    assert.deepEqual(resumed.entityAnnotations, original.entityAnnotations);
    assert.deepEqual(resumed.surfaces, original.surfaces);

    const lifecycle = await loadOrCreateApplicationContext({
      contextDirectory: path.dirname(checkpointDir), technicalGraph: input.technicalGraph, sourceFiles: input.sourceFiles,
      generateContext: true, llmOptions: input.options, applicationMap: input.applicationMap, signals: input.signals,
    });
    assert.equal(lifecycle.action, 'generated');
    assert.equal(fs.existsSync(checkpointDir), false);
  } finally { repo.cleanup(); }
});

test('context pack maps a backend change to its API, the pages that call it, navigation, rules, and old behaviour', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const context = await generateApplicationContextV2(onboardingInput(repo.dir, fake.client).input);
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'legacy' });
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
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'legacy' });
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
      contextDirectory, technicalGraph: first.input.technicalGraph, sourceFiles: first.input.sourceFiles, generateContext: true, granularity: 'functions',
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

test('file-level onboarding summarizes every file and describes no function on its own', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const progress: string[] = [];
    const { result, input } = onboardingInput(repo.dir, fake.client);
    const context = await generateApplicationContextV2({ ...input, granularity: 'files', onProgress: message => progress.push(message) });
    const production = result.technicalGraph.entities.filter(entity => !entity.file.startsWith('e2e/'));
    const files = [...new Set(production.map(entity => entity.file))].sort();
    assert.deepEqual(context.fileSummaries!.map(item => item.file).sort(), files);
    assert.ok(context.fileSummaries!.every(item => item.fingerprint && item.summary));
    assert.equal(context.meta.coverage.files, files.length);
    assert.equal(context.meta.coverage.summarizedFiles, files.length);
    assert.deepEqual(context.entityAnnotations, []);

    const requests = fake.calls.filter(call => call.schema === 'graphentra_context_files');
    assert.equal(fake.calls.filter(call => call.schema === 'graphentra_context_module').length, 0);
    assert.ok(requests.every(call => call.user.entitiesToDescribe === undefined && call.user.entities.length > 0),
      'functions are listed only so rules can link to them');
    const rule = context.rules.find(item => /minimum order amount/.test(item.statement))!;
    assert.deepEqual(rule.files, ['src/server/orderService.ts']);
    assert.ok(rule.featureIds.includes('checkout'), 'rules linked to unannotated functions still get features');
    assert.ok(progress.some(message => /^summarizing \d+ files$/.test(message)));
  } finally { repo.cleanup(); }
});

test('file-level onboarding sends at most one request per parallel slot, with low reasoning', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const { input } = onboardingInput(repo.dir, fake.client);
    await generateApplicationContextV2({ ...input, granularity: 'files', concurrency: 2 });
    const requests = fake.calls.filter(call => call.schema === 'graphentra_context_files');
    assert.ok(requests.length >= 1 && requests.length <= 2);
    assert.ok(requests.every(call => call.body.reasoning?.effort === 'low'));
    assert.ok(fake.calls.filter(call => call.schema !== 'graphentra_context_files').every(call => call.body.reasoning === undefined));
  } finally { repo.cleanup(); }
});

test('a file request that is stuck is sent once more, and the first answer wins', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm({ hangOnce: 'graphentra_context_files' });
    const progress: string[] = [];
    const { result, input } = onboardingInput(repo.dir, fake.client);
    const context = await generateApplicationContextV2({
      ...input, granularity: 'files', batchChars: 400, concurrency: 8, hedgeAfterMs: 5, onProgress: message => progress.push(message),
    });
    const files = new Set(result.technicalGraph.entities.filter(entity => !entity.file.startsWith('e2e/')).map(entity => entity.file));
    assert.equal(context.fileSummaries!.length, files.size);
    const requests = fake.calls.filter(call => call.schema === 'graphentra_context_files');
    const batches = new Set(requests.map(call => JSON.stringify(call.user.files.map((file: { path: string }) => file.path))));
    assert.ok(batches.size >= 4, 'enough requests finish to measure a median');
    assert.equal(requests.length, batches.size + 1, 'exactly one duplicate');
    assert.equal(fake.aborted, 1, 'the stuck request is cancelled once the duplicate answers');
    assert.ok(progress.includes('re-sent one slow file request'));
  } finally { repo.cleanup(); }
});

test('synthesis accepts a folder that contains listed modules without a correction request', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm({ synthesisModules: () => ['src/'] });
    const { input } = onboardingInput(repo.dir, fake.client);
    const context = await generateApplicationContextV2({ ...input, granularity: 'files' });
    assert.equal(fake.calls.filter(call => call.schema === 'graphentra_context_synthesis').length, 1);
    const listed = fake.calls.find(call => call.schema === 'graphentra_context_synthesis')!.user.modules as string[];
    assert.deepEqual(context.features[0]!.files, listed.filter(module => module.startsWith('src/')));
  } finally { repo.cleanup(); }
});

test('synthesis leaves a few modules unassigned instead of asking again, but corrects when many are missing', async t => {
  quiet(t);
  for (const [keep, expected] of [[-1, 1], [1, 2]] as const) {
    const repo = createWebAppRepository();
    try {
      const fake = createFakeLlm({ synthesisModules: modules => modules.slice(0, keep) });
      const { input } = onboardingInput(repo.dir, fake.client);
      await generateApplicationContextV2({ ...input, granularity: 'files' });
      assert.equal(fake.calls.filter(call => call.schema === 'graphentra_context_synthesis').length, expected);
    } finally { repo.cleanup(); }
  }
});

test('QA report asks again once when the model returns truncated JSON', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm({ malformedOnce: 'qa_change_impact_report' });
    const context = await generateApplicationContextV2(onboardingInput(repo.dir, fake.client).input);
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'legacy' });
    const report = await generateQAReport(changed.evidence, context, { client: fake.client, model: 'offline' }, { applicationMap: changed.applicationMap });
    assert.equal(fake.calls.filter(call => call.schema === 'qa_change_impact_report').length, 2);
    assert.ok(report.qaReport.testAreas!.length > 0);
  } finally { repo.cleanup(); }
});

test('context pack explains functions without annotations through their file summary', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const context = await generateApplicationContextV2({ ...onboardingInput(repo.dir, fake.client).input, granularity: 'files' });
    applyPaymentThresholdChange(repo.edit);
    const changed = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'legacy' });
    const pack = buildContextPack(context, changed.impacts, { applicationMap: changed.applicationMap, relations: changed.technicalGraph.relations });
    const change = pack.changes.find(item => item.changedEntityId === 'src/server/orderService.ts#chargeCard')!;
    assert.equal(change.fileRole, 'Places orders and charges the customer card at checkout.');
    assert.ok(change.rules.some(rule => /minimum order amount/.test(rule.statement)));
    assert.equal(change.features[0]!.criticality, 'critical');
    assert.deepEqual(pack.unmappedEntityIds, [], 'every relevant function is covered by an annotation or its file');
    const unannotated = change.dependentFileRoles.flatMap(item => item.entityIds);
    assert.ok(unannotated.every(id => !context.entityAnnotations.some(annotation => annotation.entityId === id)));
  } finally { repo.cleanup(); }
});

test('file-level refresh re-summarizes only changed files and is a no-op when nothing changed', async t => {
  quiet(t);
  const repo = createWebAppRepository();
  try {
    const fake = createFakeLlm();
    const { input } = onboardingInput(repo.dir, fake.client);
    const context = await generateApplicationContextV2({ ...input, granularity: 'files' });

    let before = fake.calls.length;
    const unchanged = await refreshApplicationContext(context, input);
    assert.equal(fake.calls.length, before);
    assert.equal(unchanged.summary.resummarizedFiles, 0);

    repo.edit('src/shared/pricing.ts', 'toFixed(2)', 'toFixed(3)');
    const next = onboardingInput(repo.dir, fake.client).input;
    before = fake.calls.length;
    const { context: refreshed, summary } = await refreshApplicationContext(context, next);
    const sent = fake.calls.slice(before).filter(call => call.schema === 'graphentra_context_files')
      .flatMap(call => call.user.files.map((file: any) => file.path));
    assert.deepEqual(sent, ['src/shared/pricing.ts']);
    assert.equal(summary.resummarizedFiles, 1);
    assert.equal(refreshed.fileSummaries!.length, context.fileSummaries!.length);
    const pricing = refreshed.fileSummaries!.find(item => item.file === 'src/shared/pricing.ts')!;
    assert.notEqual(pricing.fingerprint, context.fileSummaries!.find(item => item.file === 'src/shared/pricing.ts')!.fingerprint);
  } finally { repo.cleanup(); }
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
    assert.deepEqual(summary, { reannotatedEntities: 0, resummarizedFiles: 0, removedAnnotations: 0, addedSurfaces: 0, removedSurfaces: 0, preservedReviewed: 0 });
  } finally { repo.cleanup(); }
});
