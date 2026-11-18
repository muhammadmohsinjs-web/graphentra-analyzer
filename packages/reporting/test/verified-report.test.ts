import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Entity, EntityImpact } from '@graphentra/analyzer';
import { formatImpactReport, generateImpactReport, impactReportSchema, type ImpactReport } from '../src/llm-client';
import { buildNotCovered, buildRepairMessage, createFakeDecisionClient, createReportVerifier, type FakeReply } from '../src/verifier';

// Phase V Chunk 3 (V-8, V-9, V-10). Offline: a fake writer and the fake Decisions client.

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
const repaired = report(['Checkout now applies the discount before tax.', 'Cart rounding now happens once per order.']);

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

/** Covered unless the rule says otherwise; `pass` counts verifier passes (each pass asks each question once). */
function verifierFor(rule: (id: string, input: string) => FakeReply) {
  return createFakeDecisionClient((question, input) => rule(question.id, input));
}
const mentionsRounding = (input: string) => input.includes('Cart rounding');

test('V-8: one flagged entity gives exactly one repair call and a re-check', async t => {
  const writer = fakeWriter(t, [first, repaired]);
  const decisions = verifierFor((id, input) => (id === 'coverage:src/cart.ts#round' && !mentionsRounding(input) ? 0.1 : 0.95));
  const verifier = createReportVerifier(impacts, { client: decisions });

  const written = await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client, review: verifier.review });
  const { report: final, verification } = await verifier.finish(written);

  assert.equal(writer.requests.length, 2, 'one first answer, one repair');
  const repairMessage = writer.requests[1].messages.at(-1).content as string;
  assert.match(repairMessage, /src\/cart\.ts#round \(src\/cart\.ts\)/);
  assert.doesNotMatch(repairMessage, /src\/checkout\.ts#total/);
  assert.deepEqual(final, repaired);
  assert.equal(verification.passes, 2);
  assert.equal(verification.repairRequested, true);
  assert.equal(verification.repairAccepted, true);
  // 2 coverage (test entity excluded) + 1 claim on pass one, 2 + 2 on pass two.
  assert.equal(decisions.calls.length, 3 + 4);
  assert.ok(writer.logs.some(log => log.event === 'request.repair_round'));
  assert.deepEqual(writer.logs.filter(log => log.event === 'verifier.completed').map(log => log.pass), [1, 2]);
});

test('V-8: nothing flagged means no repair and a single verifier pass', async t => {
  const writer = fakeWriter(t, [first]);
  const decisions = verifierFor(() => 0.95);
  const verifier = createReportVerifier(impacts, { client: decisions });
  const { report: final, verification } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client, review: verifier.review }));
  assert.equal(writer.requests.length, 1);
  assert.deepEqual(final, first);
  assert.equal('notCovered' in final, false);
  assert.equal(verification.passes, 1);
  assert.equal(verification.repairRequested, false);
});

test('V-9: an entity the writer drops twice is listed by code; nothing is removed', async t => {
  const writer = fakeWriter(t, [first, first]);
  const decisions = verifierFor(id => (id === 'coverage:src/cart.ts#round' ? 0.2 : 0.95));
  const verifier = createReportVerifier(impacts, { client: decisions });
  const { report: final, verification } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client, review: verifier.review }));

  assert.deepEqual(final.notCovered, [{ entity: 'src/cart.ts#round', name: 'round', file: 'src/cart.ts', reason: 'low_score', score: 0.2 }]);
  const { notCovered, ...rest } = final;
  assert.deepEqual(rest, first, 'every field the writer produced is kept');
  assert.equal(verification.passes, 2);
  assert.doesNotThrow(() => impactReportSchema.parse(final));
  assert.match(formatImpactReport(final), /Not covered by this report[^\n]*\n- round in src\/cart\.ts/);
});

test('V-8: an unusable repair answer keeps the first report and its verdicts', async t => {
  const writer = fakeWriter(t, [first, '{"summary": "trunc']);
  const decisions = verifierFor(id => (id === 'coverage:src/cart.ts#round' ? 'refusal' : 0.95));
  const verifier = createReportVerifier(impacts, { client: decisions });
  const { report: final, verification } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client, review: verifier.review }));

  assert.deepEqual(final.keyChanges, first.keyChanges);
  assert.equal(final.notCovered?.[0].reason, 'refusal');
  assert.equal(verification.passes, 1, 'the first verdicts are reused, not re-asked');
  assert.equal(verification.repairAccepted, false);
  assert.ok(writer.logs.some(log => log.event === 'request.repair_rejected' && log.why === 'parse'));
});

test('V-8: the repair shares the 2-attempt cap; after a semantic retry there is no repair, only the list', async t => {
  const invalid = { ...first, qaChecks: ['Look at the checkout total.'] };
  const writer = fakeWriter(t, [invalid, first]);
  const decisions = verifierFor(id => (id === 'coverage:src/cart.ts#round' ? 0.1 : 0.95));
  const verifier = createReportVerifier(impacts, { client: decisions });
  let reviews = 0;
  const review = async (r: ImpactReport) => { reviews += 1; return verifier.review(r); };
  const { report: final, verification } = await verifier.finish(await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client, review }));

  assert.equal(writer.requests.length, 2);
  assert.equal(reviews, 0, 'no attempt left for a repair');
  assert.equal(verification.passes, 1);
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
  const message = buildRepairMessage(block, impacts)!;
  assert.match(message, /do not drop any change or check/);
  assert.doesNotMatch(message, /Totals are now rounded up/, 'covered claims are not sent back');
});

test('without review the writer is unchanged: no verifier, no notCovered, same markdown', async t => {
  const writer = fakeWriter(t, [first]);
  const written = await generateImpactReport({ instruction: 'x', evidence: {}, client: writer.client });
  assert.deepEqual(written, first);
  assert.doesNotMatch(formatImpactReport(written), /Not covered/);
  assert.ok(!writer.logs.some(log => String(log.event).startsWith('verifier.')));
});
