import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  GraphentraError, analyzeRepository, computeDeterministicEvidenceIdentity, parseCliOptions, validateEvidenceEnvelope,
} from '../src/index';
import { createRepo } from './helpers/git-fixture';

const fixtureRoot = path.resolve(__dirname, 'fixtures/web-app');

function copyFixture(target: string, source: string, relative = ''): void {
  for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(path.join(target, child), { recursive: true }); copyFixture(target, source, child); }
    else fs.copyFileSync(path.join(source, child), path.join(target, child));
  }
}

function webAppRepository() {
  const repo = createRepo('graphentra-schema3-');
  copyFixture(repo.dir, fixtureRoot);
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'initial']);
  const service = path.join(repo.dir, 'src/server/orderService.ts');
  fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace('amount < MIN_ORDER_AMOUNT', 'amount <= MIN_ORDER_AMOUNT'));
  return repo;
}

test('schema 3.0 on the web-app fixture: valid, deterministic, surfaces with provenance and affected surfaces', () => {
  const repo = webAppRepository();
  try {
    const run = () => analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, evidenceSchema: '3.0' });
    const first = run();
    const evidence = first.evidence;
    assert.equal(evidence.schemaVersion, '3.0');
    const validation = validateEvidenceEnvelope(evidence);
    assert.deepEqual(validation.errors, []);
    assert.ok(evidence.surfaces && evidence.surfaces.length > 0, 'surfaces emitted');
    assert.deepEqual(evidence.tests, []);
    assert.ok(evidence.surfaceEdges!.every(edge => edge.type === 'SURFACE_HANDLED_BY'));
    assert.ok(evidence.adapters && evidence.adapters.length > 0);
    for (const surface of evidence.surfaces) {
      assert.ok(surface.adapter.id && surface.adapter.version, `${surface.id} has provenance`);
      // D4: presentation extras never enter evidence.
      for (const key of ['uiText', 'textKeys', 'navigation', 'access', 'entryEntityIds', 'entryName']) assert.ok(!(key in surface), `${surface.id}.${key}`);
    }
    // Every map surface reaches evidence (recall: none dropped).
    assert.deepEqual(evidence.surfaces.map(s => s.id), first.applicationMap.surfaces.map(s => s.id).sort());
    const reached = evidence.impacts.flatMap(impact => impact.affectedSurfaces ?? []);
    assert.ok(reached.length > 0, 'the orderService change reaches at least one surface');
    for (const item of reached) assert.ok(evidence.surfaces.some(s => s.id === item.surfaceId) && item.path.length === item.depth + 1);
    assert.ok(!evidence.diagnostics.some(d => d.code === 'SURFACE_EXTRACTION_FAILED'));

    const second = run();
    assert.equal(computeDeterministicEvidenceIdentity(second.evidence), computeDeterministicEvidenceIdentity(evidence));
    assert.deepEqual(second.evidence.surfaces, evidence.surfaces);
    assert.deepEqual(second.evidence.impacts, evidence.impacts);

    // Default (2.1) output carries none of the 3.0 fields.
    const legacyShape = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } }).evidence;
    assert.equal(legacyShape.schemaVersion, '2.1');
    for (const key of ['surfaces', 'surfaceEdges', 'tests', 'adapters']) assert.ok(!(key in legacyShape), key);
    assert.ok(legacyShape.impacts.every(impact => impact.affectedSurfaces === undefined));
  } finally { repo.cleanup(); }
});

test('schema 3.0 requires the extended engine and a known schema value', () => {
  assert.throws(() => analyzeRepository({ target: fixtureRoot, comparison: { mode: 'working-tree' }, engine: 'legacy', evidenceSchema: '3.0' }),
    (error: unknown) => error instanceof GraphentraError && error.code === 'INVALID_OPTIONS');
  assert.throws(() => analyzeRepository({ target: fixtureRoot, comparison: { mode: 'working-tree' },
    evidenceSchema: '4.0' as unknown as '3.0' }), (error: unknown) => error instanceof GraphentraError && error.code === 'INVALID_OPTIONS');
});

test('CLI --schema accepts 2.1 and 3.0 and rejects anything else', () => {
  assert.equal(parseCliOptions(['--target', '.', '--working-tree', '--schema', '3.0']).evidenceSchema, '3.0');
  assert.equal(parseCliOptions(['--target', '.', '--working-tree', '--schema', '2.1']).evidenceSchema, '2.1');
  assert.equal(parseCliOptions(['--target', '.', '--working-tree']).evidenceSchema, undefined);
  assert.throws(() => parseCliOptions(['--target', '.', '--working-tree', '--schema', '2.0']),
    (error: unknown) => error instanceof GraphentraError && error.code === 'INVALID_OPTIONS');
});
