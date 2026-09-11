import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type OpenAI from 'openai';
import { formatImpactReport, generateImpactReport, OPENROUTER_MODEL, validateImpactReportSemantics, type ImpactReport } from '../src/llm-client';

const validReport: ImpactReport = {
  summary: 'The checkout now rejects expired discount codes.',
  impact: 'Customers can no longer use expired discounts to reduce their total.',
  qaChecks: ['Verify an expired discount is rejected and the total stays unchanged.'],
  uncertainty: [],
};

const input = {
  instruction: 'Write a concise QA report using only the supplied evidence.',
  evidence: { change: 'Reject expired discount codes at checkout.' },
};

function mockCompletions(t: TestContext, contents: (string | null)[]) {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousLog = process.env.OPENAI_LOG;
  process.env.OPENROUTER_API_KEY = 'offline-test-key';
  process.env.OPENAI_LOG = 'off';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousLog === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousLog;
  });

  const requests: { body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming; headers: Headers }[] = [];
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (message: string) => logs.push(JSON.parse(message)));
  // Intercept every SDK request, including unexpected retries, so no network call can escape.
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options?.method, 'POST');
    requests.push({ body: JSON.parse(String(options?.body)), headers: new Headers(options?.headers) });
    const index = requests.length - 1;
    assert.ok(index < contents.length, 'Unexpected extra completion request');
    return new Response(JSON.stringify({
      id: `completion-${index + 1}`,
      object: 'chat.completion',
      created: 0,
      model: OPENROUTER_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: contents[index] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `request-${index + 1}` } });
  });
  return { requests, logs, fetchMock };
}

test('returns the first valid report, trims fields, and preserves formatting and tracing', async t => {
  const { requests, logs } = mockCompletions(t, [JSON.stringify({
    ...validReport,
    summary: `  ${validReport.summary}  `,
    impact: `  ${validReport.impact}  `,
    qaChecks: [`  ${validReport.qaChecks[0]}  `],
  })]);

  const report = await generateImpactReport(input);
  assert.deepEqual(report, validReport);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, OPENROUTER_MODEL);
  assert.deepEqual(requests[0].body.messages[0], { role: 'system', content: input.instruction });
  assert.ok(String(requests[0].body.messages[1].content).endsWith(JSON.stringify(input.evidence, null, 2)));
  assert.equal(requests[0].body.response_format?.type, 'json_schema');
  assert.deepEqual(logs.map(log => log.event), ['request.started', 'request.completed']);
  assert.equal(logs[1].attempt, 1);
  assert.equal(logs[1].requestId, 'request-1');
  assert.equal(logs[1].completionId, 'completion-1');
  assert.equal(logs[1].finishReason, 'stop');
  assert.deepEqual(logs[1].usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  assert.equal(logs[0].traceId, logs[1].traceId);
  assert.equal(requests[0].headers.get('X-Client-Request-Id'), logs[0].traceId);
  assert.equal(formatImpactReport(report), `Change: ${report.summary}\nImpact: ${report.impact}\n\nQA checks:\n- ${report.qaChecks[0]}`);
});

test('corrects one semantic failure using the same evidence and the assistant response', async t => {
  const badReport = { ...validReport, summary: 'QA Report: Checkout', qaChecks: ['Expired discounts'] };
  const badContent = JSON.stringify(badReport);
  const { requests, logs } = mockCompletions(t, [badContent, JSON.stringify(validReport)]);

  assert.deepEqual(await generateImpactReport(input), validReport);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.messages.length, 2);
  assert.equal(requests[1].body.messages.length, 4);
  assert.deepEqual(requests[1].body.messages.slice(0, 2), requests[0].body.messages);
  assert.deepEqual(requests[1].body.messages[2], { role: 'assistant', content: badContent });
  assert.equal(requests[1].body.messages[3].role, 'user');
  const correction = String(requests[1].body.messages[3].content);
  assert.match(correction, /same evidence/);
  for (const error of validateImpactReportSemantics(badReport)) assert.ok(correction.includes(error));
  assert.deepEqual(requests[1].body.response_format, requests[0].body.response_format);
  assert.equal(requests[1].headers.get('X-Client-Request-Id'), requests[0].headers.get('X-Client-Request-Id'));
  assert.deepEqual(logs.map(log => log.event), ['request.started', 'request.semantic_retry', 'request.completed']);
  assert.equal(logs[1].attempt, 1);
  assert.equal(logs[1].nextAttempt, 2);
  assert.deepEqual(logs[1].errors, validateImpactReportSemantics(badReport));
  assert.equal(logs[2].attempt, 2);
  assert.equal(logs[2].requestId, 'request-2');
  assert.ok(logs.every(log => log.traceId === logs[0].traceId));
});

test('throws after two semantic failures without a third request', async t => {
  const badContent = JSON.stringify({ ...validReport, impact: '  ' });
  const { requests, logs, fetchMock } = mockCompletions(t, [badContent, badContent]);

  await assert.rejects(generateImpactReport(input), /semantically invalid.*after 2 attempts: impact must not be empty/);
  assert.equal(requests.length, 2);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.deepEqual(logs.map(log => log.event), ['request.started', 'request.semantic_retry', 'request.failed']);
  assert.equal(logs[2].attempt, 2);
});

const structuralFailures: [string, unknown][] = [
  ['missing field', { summary: validReport.summary, impact: validReport.impact, qaChecks: validReport.qaChecks }],
  ['extra field', { ...validReport, title: 'Report' }],
  ['wrong field type', { ...validReport, impact: 3 }],
  ['null report', null],
  ['empty QA array', { ...validReport, qaChecks: [] }],
  ['too many QA checks', { ...validReport, qaChecks: Array(6).fill(validReport.qaChecks[0]) }],
  ['too many uncertainties', { ...validReport, uncertainty: Array(3).fill('The evidence omits the rollout date.') }],
];

for (const [name, content, error] of [
  ['malformed JSON', '{"summary":', /not valid JSON/],
  ['empty response', null, /empty impact report/],
  ...structuralFailures.map(([name, report]) => [name, JSON.stringify(report), { name: 'ZodError' }] as const),
] as const) {
  test(`does not retry ${name}`, async t => {
    const { requests, logs } = mockCompletions(t, [content]);
    await assert.rejects(generateImpactReport(input), error);
    assert.equal(requests.length, 1);
    assert.deepEqual(logs.map(log => log.event), ['request.started', 'request.failed']);
    assert.equal(logs[1].attempt, 1);
  });
}

test('does not retry malformed JSON returned on the correction attempt', async t => {
  const { requests, logs } = mockCompletions(t, [JSON.stringify({ ...validReport, summary: '' }), 'not JSON']);
  await assert.rejects(generateImpactReport(input), /not valid JSON/);
  assert.equal(requests.length, 2);
  assert.equal(logs.at(-1)?.event, 'request.failed');
  assert.equal(logs.at(-1)?.attempt, 2);
});

test('rejects empty values and heading or Markdown content in every field', () => {
  const invalidValues = [
    '', '   ', '# Checkout', '**Checkout**', 'QA Report', 'QA Change: Checkout', 'What changed: Checkout',
    'Change: Checkout', 'Impact: Checkout', 'Summary: Checkout', 'qaChecks: Checkout', 'QA checks: Checkout',
    'Uncertainty: Checkout', 'Overview: Checkout', 'Title: Checkout', '- Checkout', '1. Checkout', '> Checkout',
    'Verify **discounts** work.', 'Verify *discounts* work.', 'Verify _discounts_ work.', 'Verify __discounts__ work.',
    'Verify `discounts` work.', 'Verify ~~discounts~~ work.', 'Verify [discounts](https://example.com) work.',
    'Verify <b>discounts</b> work.', 'Verify discounts.\nImpact: Checkout',
  ];
  for (const value of invalidValues) {
    for (const field of ['summary', 'impact', 'qaChecks', 'uncertainty'] as const) {
      const report = { ...validReport, [field]: field === 'qaChecks' || field === 'uncertainty' ? [value] : value };
      assert.ok(validateImpactReportSemantics(report).some(error => error.startsWith(field)), `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test('accepts action verbs case-insensitively but requires a word boundary', () => {
  for (const verb of ['Verify', 'check', 'CONFIRM', 'Validate', 'Test', 'Ensure']) {
    assert.deepEqual(validateImpactReportSemantics({ ...validReport, qaChecks: [`  ${verb} expired discounts are rejected.  `] }), []);
  }
  for (const value of ['Checking discounts works.', 'Verified discounts.', 'Tests pass.', 'Checkout discounts.']) {
    assert.match(validateImpactReportSemantics({ ...validReport, qaChecks: [value] }).join(' '), /qaChecks\[0\] must start with/);
  }
});

test('accepts decimals, abbreviations, precise quantities, and genuine uncertainty', () => {
  assert.deepEqual(validateImpactReportSemantics({
    summary: 'The checkout now uses a discount rate of 1.2.',
    impact: 'Customers pay $3.50 less for eligible U.S. orders.',
    qaChecks: ['Verify eligible orders use a discount rate of 1.5.'],
    uncertainty: ['The evidence does not show whether existing discounts are recalculated.'],
  }), []);
});

test('rejects the supplied incomplete impact without imposing a character limit', () => {
  const impact = 'Cancellation behavior is reversed: orders in SHIPPED status will now throw the cannot-cancel error while orders in every other non-cancelled status can be cancelled, potentially allowing cancellation of orders already shipped under the old,';
  assert.equal(impact.length, 240);
  const errors = validateImpactReportSemantics({
    ...validReport,
    summary: 'The sales tax rate applied by calculateCheckoutTotals decreased from 8% to 3%.',
    impact,
    qaChecks: ['Confirm whether test expectations in test.ts#runTests use the previous rate.'],
  });
  assert.ok(errors.some(error => error === 'impact must be a complete sentence ending with a period, question mark, or exclamation mark.'));
  assert.ok(errors.some(error => error.startsWith('summary must not include source file names or technical entity identifiers.')));
  assert.ok(errors.some(error => error.startsWith('qaChecks[0] must be plain text')));
  assert.ok(errors.some(error => error.startsWith('qaChecks[0] must verify runtime behavior')));
});

test('accepts complete report text regardless of character count', () => {
  const longButComplete = `The changed behavior has a fully expressed consequence ${'with additional supported detail '.repeat(10).trim()}.`;
  assert.ok(longButComplete.length > 240);
  assert.deepEqual(validateImpactReportSemantics({
    ...validReport,
    summary: longButComplete,
    impact: longButComplete,
  }), []);
});

test('rejects source-maintenance and automated-test recommendations', () => {
  for (const qaCheck of [
    'Check the stale inline comment and update the comment to 3%.',
    'Confirm the test suite passes with the new rate.',
    'Verify unit tests use the new cancellation expectation.',
    'Validate the source code now contains the correct value.',
  ]) {
    assert.match(validateImpactReportSemantics({ ...validReport, qaChecks: [qaCheck] }).join(' '), /must verify runtime behavior/);
  }
});
