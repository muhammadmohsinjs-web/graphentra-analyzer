import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository, type Entity, type EntityImpact, type ImpactPath } from '@graphentra/analyzer';
import { budgetBytes, buildLLMPayload, compactLLMPayload, generateQAReport, trimImpacts } from '../src/index';

const context = { schemaVersion: '1.0', application: { name: 'Test', summary: 'Test', purpose: 'Test' }, domains: [], terminology: [], entityAnnotations: [], applicationFacts: [], unknowns: [] };
const entity = (id: string): Entity => {
  const [file, name] = id.split('#') as [string, string];
  return { id, kind: 'function', name, file, startLine: 1, endLine: 3 };
};
const size = (impacts: EntityImpact[]) => Buffer.byteLength(JSON.stringify(compactLLMPayload(buildLLMPayload(impacts, context as any))));

/**
 * One changed function with 5 direct dependents and `count` indirect ones at depths 2-6. Every 7th is a test file and
 * every 5th rests on an inferred edge, so the cut order has something to sort.
 */
function wideImpact(count: number): EntityImpact {
  const changed = entity('src/core.ts#price');
  const direct = Array.from({ length: 5 }, (_, i) => entity(`src/direct${i}.ts#use${i}`));
  const indirect = Array.from({ length: count }, (_, i) => entity(`${i % 7 === 0 ? 'test' : 'src'}/deep${i % 40}/file${i}.ts#fn${i}`));
  const paths: ImpactPath[] = [
    ...direct.map(target => ({ target, depth: 1, path: [changed, target] })),
    ...indirect.map((target, i): ImpactPath => {
      const depth = 2 + (i % 5);
      const middle = Array.from({ length: depth - 1 }, (_, step) => (step === 0 ? direct[i % 5]! : indirect[(i + step * 13) % count]!));
      return { target, depth, path: [changed, ...middle, target], ...(i % 5 === 0 ? { confidence: 'likely' as const } : {}) };
    }),
  ];
  return {
    changedEntity: changed,
    change: { file: changed.file, changedLines: [2], addedCode: ['  return cents / 100;'], removedCode: ['  return cents;'], diff: '-  return cents;\n+  return cents / 100;' },
    directDependents: direct,
    blastRadius: { totalAffectedEntities: 5 + count, entities: [...direct, ...indirect], paths },
    terminalDependents: indirect.slice(-50),
  };
}

test('5,000 dependents are trimmed under budget; changed code, totals and direct dependents stay', () => {
  const impacts = [wideImpact(5000)];
  const before = size(impacts);
  const maxBytes = Math.floor(before / 4);
  const result = trimImpacts(impacts, size, maxBytes);
  assert.ok(result.fits);
  assert.ok(result.bytes <= maxBytes, `${result.bytes} > ${maxBytes}`);
  assert.equal(size(result.impacts), result.bytes);
  const [trimmed] = result.impacts;
  assert.deepEqual(trimmed!.change, impacts[0]!.change, 'changed code and diff are never cut');
  assert.deepEqual(trimmed!.directDependents, impacts[0]!.directDependents);
  for (const direct of impacts[0]!.directDependents) assert.ok(trimmed!.blastRadius.entities.some(e => e.id === direct.id), direct.id);
  assert.equal(trimmed!.blastRadius.totalAffectedEntities, 5005, 'the total still gives the full count');
  assert.equal(trimmed!.blastRadius.truncated, true);
  assert.ok(result.removed > 0 && result.removed < 5000, `removed ${result.removed}`);
});

test('every cut entity is absent from what is sent, and every absent entity is reported as cut', () => {
  const impacts = [wideImpact(800)];
  const result = trimImpacts(impacts, size, Math.floor(size(impacts) / 3));
  const sent = JSON.stringify(compactLLMPayload(buildLLMPayload(result.impacts, context as any)));
  for (const cut of result.cut) assert.ok(!sent.includes(`"${cut.id}"`), `${cut.id} was cut but is still sent`);
  const original = impacts[0]!.blastRadius.entities;
  const missing = original.filter(e => !sent.includes(`"${e.id}"`)).map(e => e.id).sort();
  assert.deepEqual(result.cut.map(e => e.id), missing);
});

test('test code goes first, then inferred edges, then the deepest', () => {
  const impacts = [wideImpact(400)];
  const result = trimImpacts(impacts, size, size(impacts) - 2000);
  const kept = new Set(result.impacts[0]!.blastRadius.entities.map(e => e.id));
  const removed = impacts[0]!.blastRadius.entities.filter(e => !kept.has(e.id));
  assert.ok(removed.length > 0);
  assert.ok(removed.every(e => e.file.startsWith('test/')), 'a small cut takes only test dependents');
  const tests = impacts[0]!.blastRadius.entities.filter(e => e.file.startsWith('test/'));
  const all = trimImpacts(impacts, size, size(impacts) - 40_000);
  const keptAll = new Set(all.impacts[0]!.blastRadius.entities.map(e => e.id));
  if (keptAll.size < impacts[0]!.blastRadius.entities.length - tests.length) {
    assert.ok(tests.every(e => !keptAll.has(e.id)), 'production is cut only after every test dependent');
  }
});

test('the same input gives the same bytes', () => {
  const run = () => {
    const result = trimImpacts([wideImpact(2000)], size, 150_000);
    return JSON.stringify(compactLLMPayload(buildLLMPayload(result.impacts, context as any))) + JSON.stringify(result.cut);
  };
  assert.equal(run(), run());
});

test('evidence within budget comes back unchanged; nothing left to cut reports it does not fit', () => {
  const impacts = [wideImpact(20)];
  const within = trimImpacts(impacts, size, size(impacts));
  assert.equal(within.impacts, impacts);
  assert.equal(within.removed, 0);
  const tooSmall = trimImpacts(impacts, size, 10);
  assert.equal(tooSmall.fits, false);
  assert.equal(tooSmall.removed, 20, 'every indirect dependent is cut, no direct one');
  assert.deepEqual(tooSmall.impacts[0]!.directDependents, impacts[0]!.directDependents);
});

test('the budget is a share of the context window', () => {
  assert.equal(budgetBytes(), 3_200_000);
  assert.equal(budgetBytes({ contextTokens: 1_000_000, share: 0.25, bytesPerToken: 4 }), 1_000_000);
});

// ---- generateQAReport end to end ----

/** `base` is called by `mid`, which 30 leaf functions call: one direct dependent, 30 indirect. */
function fanRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(dir, '.no-hooks')}`, ...args], { cwd: dir, stdio: 'pipe' });
  const write = (value: number) => {
    fs.writeFileSync(path.join(dir, 'base.ts'), `export function base() { return ${value}; }\n`);
    fs.writeFileSync(path.join(dir, 'mid.ts'), "import { base } from './base';\nexport function mid() { return base() + 1; }\n");
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(dir, `leaf${i}.ts`), `import { mid } from './mid';\nexport function leaf${i}() { return mid() * ${i}; }\n`);
  };
  git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  write(1); git(['add', '.']); git(['commit', '-m', 'initial']);
  write(2);
  return { evidence: analyzeRepository({ target: dir, comparison: { mode: 'working-tree' } }).evidence, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function fakeModel() {
  const sent: string[] = [];
  const client: any = { chat: { completions: { create: (body: any) => {
    sent.push(body.messages[1].content);
    const content = JSON.stringify({ summary: 'The base value changed.', keyChanges: ['The base value changed.'],
      testAreas: [{ area: 'Totals', surfaceIds: [], howToReach: 'Open the page.', access: 'Anyone.', setup: 'None.', checks: ['Verify the total shows the new value.'] }], uncertainty: [] });
    const completion = { id: 'fake', model: body.model, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const promise: any = Promise.resolve(completion);
    promise.withResponse = async () => ({ data: completion, request_id: 'fake' });
    return promise;
  } } } };
  return { client, sent };
}

test('a report over budget lists every dependent the model never saw under "Not covered"', async t => {
  t.mock.method(console, 'info', () => {});
  const repo = fanRepo();
  try {
    const model = fakeModel();
    const result = await generateQAReport(repo.evidence, context, { client: model.client, model: 'offline' }, { budget: { contextTokens: 1 } });
    const trimmed = (result.qaReport.notCovered ?? []).filter(item => item.reason === 'trimmed');
    assert.equal(trimmed.length, 30, 'every leaf is listed');
    assert.ok(trimmed.every(item => /^leaf\d+\.ts#leaf\d+$/.test(item.entity)));
    assert.ok(!model.sent.some(text => text.includes('leaf7.ts#leaf7')), 'a cut leaf is not sent');
    assert.ok(model.sent.some(text => text.includes('mid.ts#mid')), 'the direct dependent is always sent');
    assert.deepEqual(result.trim, { budgetBytes: 3, calls: 1, overBudget: 1, removed: 30, notSeen: 30 });
    assert.match(result.markdownReport, /leaf/);
  } finally { repo.cleanup(); }
});

test('within the default budget, or with trimming off, nothing is cut', async t => {
  t.mock.method(console, 'info', () => {});
  const repo = fanRepo();
  try {
    for (const extras of [{}, { budget: false as const }]) {
      const model = fakeModel();
      const result = await generateQAReport(repo.evidence, context, { client: model.client, model: 'offline' }, extras);
      assert.equal(result.trim, undefined);
      assert.ok(!(result.qaReport.notCovered ?? []).some(item => item.reason === 'trimmed'));
      assert.ok(model.sent.some(text => text.includes('leaf7.ts#leaf7')));
    }
    const off = fakeModel();
    const result = await generateQAReport(repo.evidence, context, { client: off.client, model: 'offline' }, { budget: false });
    assert.equal(result.trim, undefined);
  } finally { repo.cleanup(); }
});
