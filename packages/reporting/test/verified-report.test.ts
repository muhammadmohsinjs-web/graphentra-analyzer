import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Entity, EntityImpact } from '@graphentra/analyzer';
import { formatImpactReport, generateImpactReport, impactReportSchema, type ImpactReport } from '../src/llm-client';
import { buildNotCovered, createFakeDecisionClient, createReportVerifier, type FakeReply } from '../src/verifier';

// Phase V (V-9, V-10, V-13). Offline: a fake writer and the fake Decisions client. No repair round since V-13.

const entity = (file: string, name: string): Entity => ({ id: `${file}#${name}`, name, kind: 'function', file, startLine: 1, endLine: 3 });
const impact = (file: string, name: string): EntityImpact => ({
  changedEntity: entity(file, name),
  change: { file, changedLines: [1], removedCode: ['return 1;'], addedCode: ['return 2;'], diff: '' } as EntityImpact['change'],
  directDependents: [],
  blastRadius: { totalAffectedEntities: 0, entities: [], paths: [] as never },
  terminalDependents: [],
});
const impacts = [impact('src/checkout.ts', 'total'), impact('src/cart.ts', 'round'), impact('tests/checkout.test.ts', 'totalTest')];

const report = (keyChanges: string[]): ImpactReport => ({
  summary: 'Checkout totals changed.',
  keyChanges,
  qaChecks: ['Verify the checkout total with a discount code applied.'],
  uncertainty: [],
});
const first = report(['Checkout now applies the discount before tax.']);

/** Fake OpenRouter client: answers each completion with the next report (or raw string). */
function fakeWriter(t: TestContext, answers: (ImpactReport | string)[]) {
  const requests: any[] = [];
  const logs: Record<string, any>[] = [];
  t.mock.method(console, 'info', (message: string) => logs.push(JSON.parse(message)));
  const client: any = {
    chat: {
      completions: {
        create(body: any) {
          requests.push(structuredClone(body));
          const answer = answers[requests.length - 1];
          assert.ok(answer !== undefined, 'unexpected extra writer request');
          const content = typeof answer === 'string' ? answer : JSON.stringify(answer);
          const completion = { id: `c${requests.length}`, model: 'fake', choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} };
          return { withResponse: async () => ({ data: completion, request_id: `r${requests.length}` }) };
        },
      },
    },
  };
  return { client, requests, logs };
}

function verifierFor(rule: (id: string, input: string) => FakeReply) {
  return createFakeDecisionClient((question, input) => rule(question.id, input));
}

test('V-13: a flagged entity causes no extra writer call; it is listed by code and nothing is removed', async t => {
  const writer = fakeWriter(t, [first]);
  const decisions = verifierFor(id => (id === 'coverage:src/cart.ts#round' ? 0.2 : 0.95));
  const verifier = createReportVerifier(impacts, { client: decisions });
  const { report: final } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client }));

  assert.equal(writer.requests.length, 1, 'no repair round');
  // 2 coverage questions (test entity excluded) + 1 claim, asked once.
  assert.equal(decisions.calls.length, 3);
  assert.deepEqual(final.notCovered, [{ entity: 'src/cart.ts#round', name: 'round', file: 'src/cart.ts', reason: 'low_score', score: 0.2 }]);
  const { notCovered, ...rest } = final;
  assert.deepEqual(rest, first, 'every field the writer produced is kept');
  assert.doesNotThrow(() => impactReportSchema.parse(final));
  assert.match(formatImpactReport(final), /Not covered by this report[^\n]*\n- round in src\/cart\.ts/);
  assert.equal(writer.logs.filter(log => log.event === 'verifier.completed').length, 1);
});

test('nothing flagged means no notCovered list', async t => {
  const writer = fakeWriter(t, [first]);
  const verifier = createReportVerifier(impacts, { client: verifierFor(() => 0.95) });
  const { report: final, verification } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client }));
  assert.deepEqual(final, first);
  assert.equal('notCovered' in final, false);
  assert.equal(verification.verification.notCovered, 0);
});

test('a refusal is listed as not covered (recall first)', async t => {
  const writer = fakeWriter(t, [first]);
  const verifier = createReportVerifier(impacts, { client: verifierFor(id => (id === 'coverage:src/cart.ts#round' ? 'refusal' : 0.95)) });
  const { report: final } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client }));
  assert.deepEqual(final.keyChanges, first.keyChanges);
  assert.equal(final.notCovered?.[0].reason, 'refusal');
});

test('the report from a semantic retry is the one verified', async t => {
  const invalid = { ...first, qaChecks: ['Look at the checkout total.'] };
  const writer = fakeWriter(t, [invalid, first]);
  const verifier = createReportVerifier(impacts, { client: verifierFor(id => (id === 'coverage:src/cart.ts#round' ? 0.1 : 0.95)) });
  const { report: final } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client }));
  assert.equal(writer.requests.length, 2);
  assert.deepEqual(final.notCovered?.map(item => item.entity), ['src/cart.ts#round']);
});

test('a missing or failed verifier answer counts as not covered (recall first)', () => {
  const block = {
    threshold: 0.7,
    notCovered: 2,
    entries: [
      { id: 'coverage:src/checkout.ts#total', kind: 'coverage' as const, entity: 'src/checkout.ts#total', score: null, verdict: 'not_covered' as const, reason: 'missing' as const },
      { id: 'coverage:src/cart.ts#round', kind: 'coverage' as const, entity: 'src/cart.ts#round', score: null, verdict: 'not_covered' as const, reason: 'error' as const },
      { id: 'faithfulness:0', kind: 'faithfulness' as const, claim: 'Totals are now rounded up.', score: 0.9, verdict: 'covered' as const, reason: 'ok' as const },
    ],
  };
  assert.deepEqual(buildNotCovered(block, impacts).map(item => [item.name, item.reason]), [['total', 'missing'], ['round', 'error']]);
});

test('without the verifier the writer is unchanged: no verifier, no notCovered, same markdown', async t => {
  const writer = fakeWriter(t, [first]);
  const written = await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client });
  assert.deepEqual(written, first);
  assert.doesNotMatch(formatImpactReport(written), /Not covered/);
  assert.ok(!writer.logs.some(log => String(log.event).startsWith('verifier.')));
});
