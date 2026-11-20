import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityImpact } from '@graphentra/analyzer';
import { formatImpactReport, impactReportSchema, notCoveredDisplay, type ImpactReport, type NotCoveredItem } from '../src/llm-client';
import { buildPlainChecksInput, checkTextErrors, PLAIN_CHECKS_SYSTEM, plainCheckLimit, validatePlainChecks, writePlainChecks } from '../src/verifier';

// Phase V (ADR-0011), V-13e: gaps rewritten as plain QA checks; nothing is ever dropped.

const item = (file: string, name: string): NotCoveredItem => ({ entity: `${file}#${name}`, name, file, reason: 'low_score', score: 0.1 });
const impact = (file: string, name: string): EntityImpact =>
  ({ changedEntity: { id: `${file}#${name}`, name, file }, change: { file, removedCode: ['old()'], addedCode: ['new()'] }, blastRadius: { paths: [] } }) as unknown as EntityImpact;
const report: ImpactReport = { summary: 'Logger setup changed.', keyChanges: ['The logger is shared.'], qaChecks: ['Verify that the browser logger prints.'], uncertainty: [] };
const gaps = [item('src/consola.node.ts', 'createConsola'), item('src/log.types.ts', '<module>')];
const impacts = gaps.map(g => impact(g.file, g.name));

function fakeClient(...answers: unknown[]) {
  const requests: any[] = [];
  const client = {
    chat: { completions: { create: async (body: any) => {
      requests.push(body);
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return { model: 'fake', choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
    } } },
  };
  return { requests, options: { client: client as any, model: 'fake' } };
}

test('check text follows the QA check rules', () => {
  assert.deepEqual(checkTextErrors('Check that in Node the log level follows the level setting.'), []);
  assert.ok(checkTextErrors('createConsola now reads the env.').length >= 2, 'no verb, code name');
  assert.ok(checkTextErrors('Verify src/consola.ts works.').length > 0, 'no file names');
});

test('the input names every gap with a short key and keeps the report', () => {
  const { user, keys } = buildPlainChecksInput(report, gaps, impacts);
  assert.deepEqual([...keys], [['G1', 'src/consola.node.ts#createConsola'], ['G2', 'src/log.types.ts#<module>']]);
  assert.match(user, /^QA REPORT/);
  assert.match(user, /GAP G1: src\/consola\.node\.ts#createConsola/);
  assert.match(user, /Write at most 2 checks\. Gap keys: G1, G2\./);
});

test('the limit is one check per gap, at most the grouped line count', () => {
  assert.equal(plainCheckLimit(gaps), 2);
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => item('src/one.ts', name));
  assert.equal(plainCheckLimit(many), 3);
  assert.equal(plainCheckLimit([...many, item('src/b.ts', 'x'), item('src/c.ts', 'y'), item('src/d.ts', 'z')]), 4);
});

test('validation asks for every gap key and only known keys', () => {
  const keys = new Map([['G1', 'a'], ['G2', 'b']]);
  const errors = validatePlainChecks({ checks: [{ text: 'Verify that it works.', changes: ['G1', 'G9'] }], untestable: [] }, keys, 2);
  assert.ok(errors.some(e => /Unknown gap keys: G9/.test(e)));
  assert.ok(errors.some(e => /Gap keys G2 are in no check/.test(e)));
  assert.deepEqual(validatePlainChecks({ checks: [{ text: 'Verify that it works.', changes: ['G1'] }], untestable: ['G2'] }, keys, 2), []);
});

test('a valid answer becomes checks; the developer list still names every gap', async () => {
  const fake = fakeClient({ checks: [{ text: 'Check that in Node the log level follows the level setting.', changes: ['G1'] }], untestable: ['G2'] });
  const result = await writePlainChecks(report, gaps, impacts, fake.options);
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(result.checks, [{ text: 'Check that in Node the log level follows the level setting.', entities: ['src/consola.node.ts#createConsola'] }]);
  assert.deepEqual(result.untestable, ['src/log.types.ts#<module>']);
  assert.deepEqual(result.fallback, []);
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 20, calls: 1 });

  const final = { ...report, notCovered: gaps, notCoveredChecks: result.checks };
  assert.doesNotThrow(() => impactReportSchema.parse(final));
  // V-13f: the developer list keeps every gap, including the one the check claims.
  assert.deepEqual(notCoveredDisplay(final), {
    checks: ['Check that in Node the log level follows the level setting.'],
    developer: ['createConsola in src/consola.node.ts', '<module> in src/log.types.ts'],
  });
  const markdown = formatImpactReport(final);
  assert.match(markdown, /Also check \(changed behaviour the checks above do not test\):\n- Check that in Node the log level follows the level setting\.\n\nFor developers, all changed code[^\n]*\n- createConsola in src\/consola\.node\.ts\n- <module> in src\/log\.types\.ts$/);
});

test('a bad first answer gets one correction; a check that still breaks the rules is dropped and its gap kept', async () => {
  const bad = { checks: [{ text: 'createConsola reads the env.', changes: ['G1'] }], untestable: [] };
  const fake = fakeClient(bad, bad);
  const result = await writePlainChecks(report, gaps, impacts, fake.options);
  assert.equal(fake.requests.length, 2, 'one correction');
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.fallback, gaps.map(g => g.entity));
});

test('a failed call never loses a gap and never throws', async () => {
  const fake = fakeClient(new Error('provider down'));
  const result = await writePlainChecks(report, gaps, impacts, fake.options);
  assert.equal(result.error, 'provider down');
  assert.deepEqual(result.fallback, gaps.map(g => g.entity));
  const final = { ...report, notCovered: gaps };
  assert.match(formatImpactReport(final), /Not covered by this report[^\n]*\n- createConsola in src\/consola\.node\.ts\n- <module> in src\/log\.types\.ts$/);
});

test('the prompt carries the removed-code, export and honest-merge rules', () => {
  assert.match(PLAIN_CHECKS_SYSTEM, /REMOVES code[^\n]*never ask to verify that the removed behaviour still works/);
  assert.match(PLAIN_CHECKS_SYSTEM, /library exports[^\n]*IS observable/);
  assert.match(PLAIN_CHECKS_SYSTEM, /Never add a gap to a check just to place it/);
});

test('no gaps means no call', async () => {
  const fake = fakeClient({ checks: [], untestable: [] });
  const result = await writePlainChecks(report, [], impacts, fake.options);
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(result.checks, []);
});
