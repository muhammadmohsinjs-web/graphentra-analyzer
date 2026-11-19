import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Entity, EntityImpact } from '@graphentra/analyzer';
import type { ImpactReport } from '../src/llm-client';
import {
  buildCoverageItems,
  buildFaithfulnessItems,
  buildVerificationBlock,
  buildVerificationItems,
  createFakeDecisionClient,
  createOpenAIDecisionClient,
  DEFAULT_THRESHOLD,
  EVIDENCE_CAP,
  judgeAnswer,
  MAX_PROMPT_CACHE_KEY,
  MAX_QUESTIONS_PER_CALL,
  promptCacheKey,
  verifyReport,
} from '../src/verifier';

const entity = (file: string, name: string): Entity => ({ id: `${file}#${name}`, name, kind: 'function', file, startLine: 1, endLine: 3 });
const impact = (file: string, name: string, removed = 'return 1;', added = 'return 2;'): EntityImpact => ({
  changedEntity: entity(file, name),
  change: { file, changedLines: [1], removedCode: [removed], addedCode: [added], diff: '' } as EntityImpact['change'],
  directDependents: [],
  blastRadius: { totalAffectedEntities: 0, entities: [], paths: [{ target: entity('src/app.ts', 'main'), path: [entity(file, name), entity('src/app.ts', 'main')] }] as never },
  terminalDependents: [],
});
const report: ImpactReport = {
  summary: 'Checkout total changed.',
  keyChanges: ['Checkout now applies the discount before tax.', 'Rounding moved to the cart.'],
  qaChecks: ['Check the checkout total with a discount code.'],
  uncertainty: [],
};
const impacts = [impact('src/checkout.ts', 'total'), impact('src/cart.ts', 'round'), impact('tests/checkout.test.ts', 'totalTest')];

test('coverage questions: one per production entity, test entities excluded, report first for caching', () => {
  const items = buildCoverageItems(impacts, report);
  assert.deepEqual(items.map(i => i.entity), ['src/checkout.ts#total', 'src/cart.ts#round']);
  assert.ok(items.every(i => i.input.startsWith('QA REPORT')));
  assert.match(items[0].input, /BEFORE \(removed code\):\nreturn 1;/);
  assert.match(items[0].input, /Used by:\n- total -> main/);
});

test('questions are stable: same evidence and report give identical items', () => {
  assert.deepEqual(buildVerificationItems(impacts, report), buildVerificationItems(impacts, report));
});

test('faithfulness questions: one per key change; prior state only when given', () => {
  const plain = buildFaithfulnessItems(impacts, report);
  assert.equal(plain.length, 2);
  assert.ok(!plain[0].input.includes('PRIOR STATE'));
  const withPrior = buildFaithfulnessItems(impacts, report, { priorState: { 'src/cart.ts#round': 'round() already existed and was exported.', 'src/other.ts#gone': 'ignored' } });
  assert.match(withPrior[0].input, /PRIOR STATE\n- src\/cart\.ts#round: round\(\) already existed/);
  assert.ok(!withPrior[0].input.includes('src/other.ts#gone'));
  assert.match(withPrior[0].instructions, /calls something new/);
});

test('no question input exceeds its cap', () => {
  const big = Array.from({ length: 40 }, (_, i) => impact(`src/f${i}.ts`, `fn${i}`, 'x'.repeat(10_000), 'y'.repeat(10_000)));
  for (const item of buildVerificationItems(big, report)) assert.ok(item.input.length < EVIDENCE_CAP + 12_000, `${item.id} is ${item.input.length}`);
  const [first] = buildFaithfulnessItems(big, report);
  assert.ok(first.input.length < EVIDENCE_CAP + 1000);
});

test('verdict policy covers every answer type', () => {
  const [item] = buildCoverageItems(impacts, report);
  const verdict = (answer: Parameters<typeof judgeAnswer>[1]) => judgeAnswer(item, answer);
  assert.deepEqual(verdict({ id: item.id, outcome: 'answer', probability: 0.9 }), { id: item.id, kind: 'coverage', entity: item.entity, score: 0.9, verdict: 'covered', reason: 'ok' });
  assert.equal(verdict({ id: item.id, outcome: 'answer', probability: DEFAULT_THRESHOLD }).verdict, 'covered');
  assert.equal(verdict({ id: item.id, outcome: 'answer', probability: 0.69 }).reason, 'low_score');
  assert.equal(verdict({ id: item.id, outcome: 'refusal' }).reason, 'refusal');
  assert.equal(verdict({ id: item.id, outcome: 'error', message: 'timeout' }).reason, 'error');
  assert.equal(verdict({ id: item.id, outcome: 'answer', probability: Number.NaN }).verdict, 'not_covered');
  assert.deepEqual(verdict(undefined), { id: item.id, kind: 'coverage', entity: item.entity, score: null, verdict: 'not_covered', reason: 'missing' });
});

test('verification block counts a dropped answer as not covered', async () => {
  const fake = createFakeDecisionClient(q => (q.id === 'coverage:src/cart.ts#round' ? 'omit' : 0.95));
  const { verification } = await verifyReport({ client: fake, impacts, report });
  assert.equal(verification.threshold, 0.7);
  assert.equal(verification.entries.length, 4);
  assert.equal(verification.notCovered, 1);
  assert.equal(verification.entries.find(e => e.entity === 'src/cart.ts#round')?.reason, 'missing');
});

test('refusal and error flag; the verifier never throws on provider problems', async () => {
  const fake = createFakeDecisionClient(q => (q.id.startsWith('coverage') ? 'refusal' : 'error'));
  const { verification } = await verifyReport({ client: fake, impacts, report });
  assert.equal(verification.notCovered, verification.entries.length);
});

test('buildVerificationBlock uses a custom threshold', () => {
  const items = buildCoverageItems(impacts, report);
  const answers = new Map(items.map(i => [i.id, { id: i.id, outcome: 'answer' as const, probability: 0.8 }]));
  assert.equal(buildVerificationBlock(items, answers, 0.9).notCovered, items.length);
  assert.equal(buildVerificationBlock(items, answers, 0.5).notCovered, 0);
});

test('verifyReport shares one cache key per question group', async () => {
  const fake = createFakeDecisionClient();
  await verifyReport({ client: fake, impacts, report, cacheKey: 'abc' });
  assert.deepEqual([...new Set(fake.calls.map(c => c.options.cacheKey))].sort(), ['gv-abc-coverage', 'gv-abc-faithfulness']);
});

test('verifyReport cache keys fit the 64-character API limit with a UUID run key', async () => {
  // Regression: `graphentra-verify-<uuid>-faithfulness` was 67 characters, so every faithfulness question got HTTP 400.
  const fake = createFakeDecisionClient();
  await verifyReport({ client: fake, impacts, report, cacheKey: randomUUID() });
  for (const call of fake.calls) assert.ok(call.options.cacheKey!.length <= MAX_PROMPT_CACHE_KEY, call.options.cacheKey);
});

test('openai adapter: a cache key over 64 characters is hashed to a stable 64-character key', async () => {
  const sent: string[] = [];
  const client = createOpenAIDecisionClient({ apiKey: 'k', fetch: async (_url, init) => (sent.push(JSON.parse(String(init!.body)).prompt_cache_key), new Response(okBody(1))) });
  const long = `x${'y'.repeat(80)}`;
  await client.decide('input', questions(1), { cacheKey: long });
  await client.decide('input', questions(1), { cacheKey: long });
  assert.equal(sent[0]!.length, MAX_PROMPT_CACHE_KEY);
  assert.equal(sent[0], sent[1]);
  assert.equal(promptCacheKey('short'), 'short');
});

// ---- OpenAI adapter, with a stubbed fetch (no network) ----
const okBody = (n: number, p = 0.9) => JSON.stringify({ model: 'gpt-6-luna', answers: Array.from({ length: n }, (_, i) => ({ type: 'predicate', name: `q${i}`, probability: p })), usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 5 } });
const questions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, instructions: `question ${i}` }));

test('openai adapter: maps answers, usage, cache key and auth header', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = createOpenAIDecisionClient({ apiKey: 'k', fetch: async (url, init) => ((seen = { url: String(url), init: init! }), new Response(okBody(2))) });
  const result = await client.decide('input', questions(2), { cacheKey: 'ck' });
  assert.equal(seen!.url, 'https://api.openai.com/v1/decisions');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer k');
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.prompt_cache_key, 'ck');
  assert.deepEqual(body.questions.map((q: { type: string; name: string }) => [q.type, q.name]), [['predicate', 'q0'], ['predicate', 'q1']]);
  assert.deepEqual(result.answers, [{ id: 'id0', outcome: 'answer', probability: 0.9 }, { id: 'id1', outcome: 'answer', probability: 0.9 }]);
  assert.deepEqual(result.usage, { inputTokens: 100, cachedTokens: 40, outputTokens: 5 });
});

test('openai adapter: refusal, bad answer and missing answer', async () => {
  const body = JSON.stringify({ answers: [{ type: 'refusal', name: 'q0' }, { type: 'predicate', name: 'q1', probability: 7 }] });
  const client = createOpenAIDecisionClient({ apiKey: 'k', fetch: async () => new Response(body) });
  const result = await client.decide('i', questions(3));
  assert.equal(result.answers.find(a => a.id === 'id0')?.outcome, 'refusal');
  assert.equal(result.answers.find(a => a.id === 'id1')?.outcome, 'error');
  assert.equal(result.answers.find(a => a.id === 'id2'), undefined);
});

test('openai adapter: retries 429/5xx twice, then reports errors instead of throwing', async () => {
  let calls = 0;
  const slept: number[] = [];
  const client = createOpenAIDecisionClient({ apiKey: 'k', sleep: async ms => void slept.push(ms), fetch: async () => (calls++, new Response('busy', { status: 503 })) });
  const result = await client.decide('i', questions(2));
  assert.equal(calls, 3);
  assert.deepEqual(slept, [500, 1500]);
  assert.ok(result.answers.every(a => a.outcome === 'error'));
});

test('openai adapter: recovers after a transient failure; does not retry a 400', async () => {
  let n = 0;
  const flaky = createOpenAIDecisionClient({ apiKey: 'k', sleep: async () => {}, fetch: async () => (n++ === 0 ? new Response('x', { status: 500 }) : new Response(okBody(1))) });
  assert.equal((await flaky.decide('i', questions(1))).answers[0].outcome, 'answer');
  let bad = 0;
  const rejected = createOpenAIDecisionClient({ apiKey: 'k', sleep: async () => {}, fetch: async () => (bad++, new Response('no', { status: 400 })) });
  assert.equal((await rejected.decide('i', questions(1))).answers[0].outcome, 'error');
  assert.equal(bad, 1);
});

test('openai adapter: splits above 400 questions with the same input and cache key', async () => {
  const sizes: number[] = [];
  const keys = new Set<string>();
  const client = createOpenAIDecisionClient({ apiKey: 'k', fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    sizes.push(body.questions.length);
    keys.add(`${body.input}|${body.prompt_cache_key}`);
    return new Response(okBody(body.questions.length));
  } });
  const result = await client.decide('shared', questions(MAX_QUESTIONS_PER_CALL * 2 + 5), { cacheKey: 'ck' });
  assert.deepEqual(sizes, [400, 400, 5]);
  assert.equal(keys.size, 1);
  assert.equal(result.answers.length, 805);
  assert.equal(result.usage.inputTokens, 300);
});

test('openai adapter: needs its own key', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => createOpenAIDecisionClient(), /OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

// One real call, only when asked for. Never runs in CI or `npm test` by default.
test('live: OpenAI Decisions answers a yes/no question', { skip: !(process.env.GRAPHENTRA_LIVE_DECISIONS === '1' && process.env.OPENAI_API_KEY) }, async () => {
  const result = await createOpenAIDecisionClient().decide('The sky is blue.', [{ id: 'q', instructions: 'Answer true if the input says the sky is blue.' }]);
  assert.equal(result.answers[0]?.outcome, 'answer');
  assert.ok((result.answers[0] as { probability: number }).probability > 0.7);
});
