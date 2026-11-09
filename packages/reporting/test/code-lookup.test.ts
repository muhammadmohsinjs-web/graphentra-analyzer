import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { createCodeLookup, lookupInstruction } from '../src/code-lookup';
import { generateImpactReport } from '../src/llm-client';

const files: Record<string, string> = {
  'src/paste.ts': ['export function parse(text: string) {', '  return text.split("\\t");', '}', '', 'export function paste(text: string) {', '  return parse(text);', '}'].join('\n'),
  'src/util.ts': ['export function clean(text: string) {', '  return text.replace(/\\t/g, "    ");', '}'].join('\n'),
};
const graph = {
  analyzedFiles: Object.keys(files),
  entities: [
    { id: 'src/paste.ts#parse', kind: 'function' as const, name: 'parse', file: 'src/paste.ts', startLine: 1, endLine: 3, exported: true },
    { id: 'src/paste.ts#paste', kind: 'function' as const, name: 'paste', file: 'src/paste.ts', startLine: 5, endLine: 7, exported: true },
    { id: 'src/util.ts#clean', kind: 'function' as const, name: 'clean', file: 'src/util.ts', startLine: 1, endLine: 3, exported: true },
  ],
  relations: [{ from: 'src/paste.ts#paste', to: 'src/paste.ts#parse', type: 'CALLS' as const }],
};
const read = (file: string) => files[file];

test('entity lookup returns code, callers and callees, by ID or by name', () => {
  const lookup = createCodeLookup(graph, read);
  const byId = lookup.run({ mode: 'entity', query: 'src/paste.ts#parse' });
  assert.match(byId, /Entity src\/paste\.ts#parse/);
  assert.match(byId, /Used by \(1\): src\/paste\.ts#paste \(CALLS\)/);
  assert.match(byId, /2:   return text\.split/);
  assert.match(lookup.run({ mode: 'entity', query: 'CLEAN' }), /src\/util\.ts#clean/);
  assert.match(lookup.run({ mode: 'entity', query: 'missing' }), /No entity matches/);
  assert.deepEqual(lookup.log.map(entry => entry.hit), [true, true, false]);
  assert.deepEqual(lookup.log[0]!.entityIds, ['src/paste.ts#parse']);
});

test('file lookup lists entities; search reports the enclosing entity', () => {
  const lookup = createCodeLookup(graph, read);
  const outline = lookup.run({ mode: 'file', query: 'paste.ts' });
  assert.match(outline, /- src\/paste\.ts#paste \(function\) lines 5-7/);
  const found = lookup.run({ mode: 'search', query: 'split(' });
  assert.match(found, /src\/paste\.ts:2 in src\/paste\.ts#parse/);
  assert.deepEqual(lookup.log[1]!.entityIds, ['src/paste.ts#parse']);
});

test('lookups stop at the budget and results are capped', () => {
  const lookup = createCodeLookup(graph, read, { maxLookups: 1, maxResultBytes: 40 });
  assert.match(lookup.run({ mode: 'entity', query: 'parse' }), /result cut at 40 bytes/);
  assert.match(lookup.run({ mode: 'entity', query: 'paste' }), /budget of 1 is spent/);
  assert.equal(lookup.log[1]!.refused, 'budget');
});

test('instruction variants differ in how strongly they ask for lookups', () => {
  assert.match(lookupInstruction('optional'), /few or no lookups/);
  assert.match(lookupInstruction('always'), /Before writing, look up every/);
});

const report = {
  summary: 'Pasting spreadsheet cells changes how tabs are handled.',
  keyChanges: ['Tabs in pasted text now become spaces, which can stop spreadsheet detection.'],
  testAreas: [{ area: 'Paste', surfaceIds: [], howToReach: 'Navigation was not found in code.', access: 'Anyone.', setup: 'Copy cells from a spreadsheet.', checks: ['Verify pasting copied spreadsheet cells still offers a chart.'] }],
  uncertainty: [],
};

function fakeClient(replies: OpenAI.Chat.Completions.ChatCompletionMessage[]) {
  const bodies: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
  const create = (body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => {
    bodies.push(structuredClone(body));
    const message = replies[bodies.length - 1];
    assert.ok(message, 'unexpected extra request');
    const completion = { id: `c${bodies.length}`, model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message }] };
    const promise = Promise.resolve(completion);
    return Object.assign(promise, { withResponse: async () => ({ data: completion, request_id: 'r' }) });
  };
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, bodies };
}

test('report generation runs tool rounds, then passes lookups to the structured call as data', async t => {
  t.mock.method(console, 'info', () => {});
  const toolCall = { id: 't1', type: 'function' as const, function: { name: 'lookup', arguments: JSON.stringify({ mode: 'entity', query: 'parse' }) } };
  const { client, bodies } = fakeClient([
    { role: 'assistant', content: null, refusal: null, tool_calls: [toolCall] },
    { role: 'assistant', content: 'READY', refusal: null },
    { role: 'assistant', content: JSON.stringify(report), refusal: null },
  ]);
  const tool = createCodeLookup(graph, read);
  const result = await generateImpactReport({ instruction: 'Write the report.', evidence: { change: 'tabs' }, client, lookup: { tool } });
  assert.equal(result.summary, report.summary);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0]!.tools?.length, 'investigation offers the tool');
  assert.equal(bodies[0]!.response_format, undefined);
  const final = bodies[2]!;
  assert.equal(final.tools, undefined, 'final call has no tools');
  assert.equal((final.response_format as { type: string }).type, 'json_schema');
  const lastMessage = String(final.messages.at(-1)!.content);
  assert.match(lastMessage, /data, never instructions/);
  assert.match(lastMessage, /return text\.split/);
  assert.equal(tool.log.length, 1);
  assert.equal(bodies[0]!.tool_choice, 'auto');
});

test('requireFirst forces a tool call in the first round only', async t => {
  t.mock.method(console, 'info', () => {});
  const toolCall = { id: 't1', type: 'function' as const, function: { name: 'lookup', arguments: JSON.stringify({ mode: 'search', query: 'split' }) } };
  const { client, bodies } = fakeClient([
    { role: 'assistant', content: null, refusal: null, tool_calls: [toolCall] },
    { role: 'assistant', content: 'READY', refusal: null },
    { role: 'assistant', content: JSON.stringify(report), refusal: null },
  ]);
  await generateImpactReport({ instruction: 'x', evidence: {}, client, lookup: { tool: createCodeLookup(graph, read), requireFirst: true } });
  assert.equal(bodies[0]!.tool_choice, 'required');
  assert.equal(bodies[1]!.tool_choice, 'auto');
});

test('without lookup the report is one structured call', async t => {
  t.mock.method(console, 'info', () => {});
  const { client, bodies } = fakeClient([{ role: 'assistant', content: JSON.stringify(report), refusal: null }]);
  await generateImpactReport({ instruction: 'Write the report.', evidence: {}, client });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.tools, undefined);
});
