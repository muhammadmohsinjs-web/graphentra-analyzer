import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  analyzeRepository, buildPhase5Evidence, computeDeterministicEvidenceIdentity, validateEvidenceEnvelope,
  type DeterministicEvidence, type Phase5Input,
} from '../src/index';
import { createRepo } from './helpers/git-fixture';

/**
 * Phase 5 goal: `--schema 3.0` answers "this change affects page X and endpoint Y; run tests T; surface U is
 * uncovered" deterministically. Regenerate the golden deliberately with:
 * UPDATE_GOLDENS=1 node --import tsx --test test/phase5-goal.test.ts
 */
const FIXTURE = path.join(__dirname, 'fixtures/phase5-goal');
const GOLDEN = path.join(__dirname, 'golden/phase5-goal.schema-3.0.json');
const UPDATE = process.env.UPDATE_GOLDENS === '1';
const TEST_ID = 'test:e2e/checkout.spec.ts#checkout > pays for an order';
const ENDPOINT = 'api:POST /api/orders';

function goalRepository(mutate?: (dir: string) => void) {
  const repo = createRepo('graphentra-phase5-goal-');
  fs.cpSync(FIXTURE, repo.dir, { recursive: true });
  mutate?.(repo.dir);
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'initial']);
  const base = repo.git(['rev-parse', 'HEAD']);
  const orders = path.join(repo.dir, 'lib/orders.ts');
  const head = repo.commitFile('lib/orders.ts', fs.readFileSync(orders, 'utf8').replace('amount < 1', 'amount <= 0'), 'change handler');
  return { repo, base, head };
}

function normalize(evidence: DeterministicEvidence): unknown {
  const parsed = JSON.parse(JSON.stringify(evidence).replace(/\b[0-9a-f]{40}\b/g, '<SHA>'));
  delete parsed.technicalGraph?.repository?.generatedAt;
  parsed.analyzerVersion = '<VERSION>';
  if (parsed.technicalGraph?.repository?.analyzerVersion) parsed.technicalGraph.repository.analyzerVersion = '<VERSION>';
  if (parsed.sourceState?.contentIdentity) parsed.sourceState.contentIdentity = '<CONTENT>';
  if (parsed.toolchain?.node) parsed.toolchain.node = '<NODE>';
  return parsed;
}

test('phase 5 goal: the change affects page and endpoint, names the test to run and the uncovered page', () => {
  const { repo, base, head } = goalRepository();
  try {
    const run = () => analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, evidenceSchema: '3.0' }).evidence;
    const evidence = run();
    assert.equal(evidence.schemaVersion, '3.0');
    assert.deepEqual(validateEvidenceEnvelope(evidence).errors, []);

    const impact = evidence.impacts.find(item => item.changedEntity.id === 'lib/orders.ts#createOrder');
    assert.ok(impact, 'the handler change is an impact');
    const affected = new Map((impact.affectedSurfaces ?? []).map(item => [item.surfaceId, item]));
    assert.deepEqual(affected.get(ENDPOINT)?.path, ['lib/orders.ts#createOrder', 'app/api/orders/route.ts#POST', ENDPOINT]);
    assert.deepEqual(affected.get('ui:/checkout')?.path, ['lib/orders.ts#createOrder', 'app/api/orders/route.ts#POST', ENDPOINT,
      'app/checkout/page.tsx#CheckoutPage>pay', 'app/checkout/page.tsx#CheckoutPage', 'ui:/checkout']);
    assert.ok(affected.has('ui:/quick-buy'));

    // P5-4: the page's literal fetch is a proven link to the endpoint.
    assert.ok(evidence.surfaceEdges!.some(edge => edge.type === 'CALLS_ENDPOINT' && edge.from === 'app/checkout/page.tsx#CheckoutPage>pay'
      && edge.to === ENDPOINT && edge.confidence === 'proven'));
    // P5-7: the Playwright goto covers the checkout page.
    assert.ok(evidence.surfaceEdges!.some(edge => edge.type === 'TEST_COVERS' && edge.from === TEST_ID && edge.to === 'ui:/checkout' && edge.via === 'goto'));
    assert.deepEqual(evidence.testMapping, {
      basis: 'static-reach',
      testsToRun: [{ testId: TEST_ID, reaches: [ENDPOINT, 'ui:/checkout'] }],
      uncoveredSurfaces: ['ui:/quick-buy'],
    });

    // P5-5: criticality from graphentra.yml, config recorded, ignore applied.
    const byId = new Map(evidence.surfaces!.map(surface => [surface.id, surface]));
    assert.equal(byId.get(ENDPOINT)?.criticality, 'critical');
    assert.equal(byId.get('ui:/checkout')?.criticality, 'normal');
    assert.equal(evidence.config?.file, 'graphentra.yml');
    assert.match(evidence.config!.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!evidence.technicalGraph.entities.some(entity => entity.file.startsWith('scripts/')), 'ignore: scripts/** is excluded');
    assert.ok(evidence.options.excludePaths.includes('scripts/**'));

    const second = run();
    assert.equal(computeDeterministicEvidenceIdentity(second), computeDeterministicEvidenceIdentity(evidence));
    assert.deepEqual(normalize(second), normalize(evidence));

    const normalized = normalize(evidence);
    if (UPDATE) fs.writeFileSync(GOLDEN, `${JSON.stringify(normalized, null, 2)}\n`);
    assert.ok(fs.existsSync(GOLDEN), `Missing golden ${GOLDEN}. Run with UPDATE_GOLDENS=1 to create it.`);
    assert.deepEqual(normalized, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));

    // D12: graphentra.yml never affects 2.1 output.
    const legacy = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head } }).evidence;
    assert.equal(legacy.schemaVersion, '2.1');
    assert.ok(legacy.technicalGraph.entities.some(entity => entity.file.startsWith('scripts/')));
    assert.ok(!('config' in legacy) && !legacy.diagnostics.some(item => item.code.startsWith('CONFIG_')));
  } finally { repo.cleanup(); }
});

test('graphentra.yml: an invalid file is an error diagnostic and is ignored; a config surface is proven', () => {
  const invalid = goalRepository(dir => fs.writeFileSync(path.join(dir, 'graphentra.yml'), 'version: 2\nignore:\n  - scripts/**\n'));
  try {
    const evidence = analyzeRepository({ target: invalid.repo.dir, comparison: { mode: 'commit', base: invalid.base, head: invalid.head },
      evidenceSchema: '3.0' }).evidence;
    assert.deepEqual(validateEvidenceEnvelope(evidence).errors, []);
    const diagnostic = evidence.diagnostics.find(item => item.code === 'CONFIG_INVALID');
    assert.equal(diagnostic?.severity, 'error');
    assert.equal(evidence.config, undefined);
    assert.ok(evidence.technicalGraph.entities.some(entity => entity.file.startsWith('scripts/')), 'ignore of an invalid config is not applied');
    assert.ok(evidence.surfaces!.every(surface => surface.criticality === undefined));
    assert.ok(evidence.testMapping && evidence.testMapping.testsToRun.length === 1, 'analysis continues');
  } finally { invalid.repo.cleanup(); }

  const manual = goalRepository(dir => fs.writeFileSync(path.join(dir, 'graphentra.yml'),
    'version: 1\nsurfaces:\n  - id: "job:seed"\n    kind: scheduled_job\n    route: seed\n    handler: "scripts/seed.ts#seed"\n' +
    '  - id: "job:missing"\n    kind: scheduled_job\n    route: missing\n    handler: "nowhere.ts#gone"\ntests:\n  - "e2e/**"\n'));
  try {
    const evidence = analyzeRepository({ target: manual.repo.dir, comparison: { mode: 'commit', base: manual.base, head: manual.head },
      evidenceSchema: '3.0' }).evidence;
    assert.deepEqual(validateEvidenceEnvelope(evidence).errors, []);
    const job = evidence.surfaces!.find(surface => surface.id === 'job:seed');
    assert.deepEqual(job && { source: job.source, confidence: job.confidence, handlers: job.handlerEntityIds, file: job.file, adapter: job.adapter.id },
      { source: 'config', confidence: 'proven', handlers: ['scripts/seed.ts#seed'], file: 'scripts/seed.ts', adapter: 'config' });
    assert.ok(evidence.surfaceEdges!.some(edge => edge.from === 'job:seed' && edge.type === 'SURFACE_HANDLED_BY' && edge.to === 'scripts/seed.ts#seed'));
    assert.ok(evidence.impacts.some(impact => impact.affectedSurfaces?.some(item => item.surfaceId === 'job:seed')), 'the change reaches the config surface');
    assert.ok(evidence.testMapping!.uncoveredSurfaces.includes('job:seed'));
    assert.ok(!evidence.surfaces!.some(surface => surface.id === 'job:missing'));
    assert.ok(evidence.diagnostics.some(item => item.code === 'CONFIG_SURFACE_HANDLER_NOT_FOUND'));
  } finally { manual.repo.cleanup(); }
});

test('graphentra.yml: ignore/tests entries outside the project are CONFIG_INVALID, not a validation failure', () => {
  for (const [yml, line] of [['ignore:\n  - "../outside"\n', 3], ['ignore:\n  - "/abs/**"\n', 3], ['tests:\n  - "a//b"\n', 3]] as const) {
    const { repo, base, head } = goalRepository(dir => fs.writeFileSync(path.join(dir, 'graphentra.yml'), `version: 1\n${yml}`));
    try {
      const evidence = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, evidenceSchema: '3.0' }).evidence;
      assert.deepEqual(validateEvidenceEnvelope(evidence).errors, []);
      const diagnostic = evidence.diagnostics.find(item => item.code === 'CONFIG_INVALID');
      assert.equal(diagnostic?.severity, 'error');
      assert.ok(diagnostic?.message.startsWith(`graphentra.yml:${line}:`), diagnostic?.message);
      assert.equal(evidence.config, undefined);
      assert.ok(evidence.options.excludePaths.every(value => !value.startsWith('/') && !value.includes('..')));
    } finally { repo.cleanup(); }
  }
});

test('schema 3.0: an unresolvable fetch URL is a dynamic_endpoint_url frontier item of the calling entity', () => {
  const { repo, base, head } = goalRepository(dir => fs.writeFileSync(path.join(dir, 'lib/client.ts'),
    "import { createOrder } from './orders';\n\nexport async function send(url: string) {\n  createOrder(2);\n  return fetch(url, { method: 'POST' });\n}\n"));
  try {
    const evidence = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, evidenceSchema: '3.0' }).evidence;
    assert.deepEqual(validateEvidenceEnvelope(evidence).errors, []);
    assert.ok(evidence.frontier!.some(item => item.reason === 'dynamic_endpoint_url' && item.entityId === 'lib/client.ts#send'),
      'send depends on the changed createOrder, so its frontier site is reported');
    const legacy = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head } }).evidence;
    assert.ok(!legacy.frontier!.some(item => item.reason === 'dynamic_endpoint_url'), '2.1 frontier is unchanged');
  } finally { repo.cleanup(); }
});

test('D10: surface and test extraction failures never block evidence', () => {
  const { repo, base, head } = goalRepository();
  try {
    const evidence = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, evidenceSchema: '3.0' }).evidence;
    // Re-run the 3.0 stage on the real inputs with throwing stages.
    const input: Phase5Input = {
      extracted: { technicalGraph: evidence.technicalGraph, entities: evidence.technicalGraph.entities, relations: evidence.technicalGraph.relations,
        diagnostics: [], parentById: new Map(), entityById: new Map(), reverseAdjacency: new Map(), files: [], frontier: [] },
      mapResult: { map: {} as Phase5Input['mapResult']['map'], provenance: new Map() },
      frameworkVersions: [], impacts: evidence.impacts.map(({ affectedSurfaces: _drop, ...impact }) => impact),
    };
    const boom = (): never => { throw new Error('boom'); };
    const both = buildPhase5Evidence({ ...input, stages: { surfaces: boom, tests: boom } });
    assert.deepEqual([both.surfaces, both.surfaceEdges, both.tests, both.adapters, both.frontier], [[], [], [], [], []]);
    assert.equal(both.testMapping, undefined);
    assert.deepEqual(both.diagnostics.map(item => [item.code, item.severity]),
      [['SURFACE_EXTRACTION_FAILED', 'warning'], ['TEST_EXTRACTION_FAILED', 'warning']]);
    assert.ok(both.impacts.every(impact => impact.affectedSurfaces === undefined));

    // A real map failure (mapResult.failure) takes the same surface path; tests still run on what is left, but no
    // testMapping is emitted: `uncoveredSurfaces: []` without surfaces would read as "everything covered".
    const mapFailed = buildPhase5Evidence({ ...input, mapResult: { ...input.mapResult, failure: 'Application map extraction failed: x' },
      stages: { tests: () => ({ tests: [], edges: [] }) } });
    assert.deepEqual(mapFailed.diagnostics.map(item => item.code), ['SURFACE_EXTRACTION_FAILED']);
    assert.equal(mapFailed.testMapping, undefined);
    assert.equal('testMapping' in mapFailed, false);

    const testsOnly = buildPhase5Evidence({ ...input, stages: { surfaces: () => ({ surfaces: evidence.surfaces!,
      surfaceEdges: evidence.surfaceEdges!.filter(edge => edge.type !== 'TEST_COVERS'), adapters: [], frontier: [], diagnostics: [] }), tests: boom } });
    assert.deepEqual(testsOnly.diagnostics.map(item => item.code), ['TEST_EXTRACTION_FAILED']);
    assert.ok(testsOnly.impacts.some(impact => impact.affectedSurfaces?.some(item => item.surfaceId === ENDPOINT)), 'surfaces survive a test failure');
    const document = { ...evidence, surfaces: testsOnly.surfaces, surfaceEdges: testsOnly.surfaceEdges, tests: testsOnly.tests,
      impacts: testsOnly.impacts, diagnostics: [...evidence.diagnostics, ...testsOnly.diagnostics] };
    delete (document as Partial<DeterministicEvidence>).testMapping;
    assert.deepEqual(validateEvidenceEnvelope(document).errors, []);
  } finally { repo.cleanup(); }
});
