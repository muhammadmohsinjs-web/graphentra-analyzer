import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenRouterDecisionClient, OPENROUTER_DECISIONS_MODEL, parseOpenRouterAnswers } from '../src/verifier';

// Eval-only verifier route through OpenRouter (Luna). Stubbed fetch, no network.
const reply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } }) =>
  new Response(JSON.stringify({ model: 'openai/gpt-6-luna', choices: [{ message: { content } }], usage }));
const questions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, instructions: `statement ${i}` }));
const answersJson = (entries: Array<[string, number]>) => JSON.stringify({ answers: entries.map(([name, probability]) => ({ name, probability })) });

test('openrouter route: sends Luna with JSON output, input first, and maps answers and usage', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = createOpenRouterDecisionClient({ apiKey: 'k', fetch: async (url, init) => ((seen = { url: String(url), init: init! }), reply(answersJson([['q0', 0.9], ['q1', 0.2]]))) });
  const result = await client.decide('the change', questions(2));
  assert.equal(seen!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer k');
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.model, OPENROUTER_DECISIONS_MODEL);
  assert.equal(body.response_format.type, 'json_object');
  assert.ok(body.messages[1].content.startsWith('the change'));
  assert.ok(body.messages[1].content.includes('q1: statement 1'));
  assert.deepEqual(result.answers, [{ id: 'id0', outcome: 'answer', probability: 0.9 }, { id: 'id1', outcome: 'answer', probability: 0.2 }]);
  assert.deepEqual(result.usage, { inputTokens: 100, cachedTokens: 40, outputTokens: 7 });
});

test('openrouter route: reads a fenced reply, leaves out missing statements, errors on a bad probability', async () => {
  const fenced = '```json\n' + answersJson([['q0', 1], ['q1', 7]]) + '\n```';
  const client = createOpenRouterDecisionClient({ apiKey: 'k', fetch: async () => reply(fenced) });
  const result = await client.decide('i', questions(3));
  assert.equal(result.answers.find(a => a.id === 'id0')?.outcome, 'answer');
  assert.equal(result.answers.find(a => a.id === 'id1')?.outcome, 'error');
  assert.equal(result.answers.find(a => a.id === 'id2'), undefined);
});

test('openrouter route: an unparseable reply is an error for every question, not a throw', async () => {
  const client = createOpenRouterDecisionClient({ apiKey: 'k', fetch: async () => reply('I think so.') });
  const result = await client.decide('i', questions(2));
  assert.ok(result.answers.every(a => a.outcome === 'error'));
});

test('openrouter route: retries 503 twice, then reports errors', async () => {
  let calls = 0;
  const slept: number[] = [];
  const client = createOpenRouterDecisionClient({ apiKey: 'k', sleep: async ms => void slept.push(ms), fetch: async () => (calls++, new Response('busy', { status: 503 })) });
  const result = await client.decide('i', questions(2));
  assert.equal(calls, 3);
  assert.deepEqual(slept, [500, 1500]);
  assert.ok(result.answers.every(a => a.outcome === 'error'));
});

test('openrouter route: splits above 400 questions', async () => {
  let calls = 0;
  const client = createOpenRouterDecisionClient({ apiKey: 'k', fetch: async () => (calls++, reply(answersJson([]))) });
  await client.decide('i', questions(401));
  assert.equal(calls, 2);
});

test('openrouter route: parser accepts a bare object and ignores entries without a name', () => {
  const parsed = parseOpenRouterAnswers('{"answers":[{"probability":0.5},{"name":"q0","probability":0.4}]}');
  assert.deepEqual([...parsed], [['q0', 0.4]]);
});

test('openrouter route: needs its own key', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.throws(() => createOpenRouterDecisionClient(), /OPENROUTER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});
