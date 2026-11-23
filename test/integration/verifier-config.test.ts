import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReportVerification } from '@graphentra/reporting';
import { percentile, readVerifierConfig, summarizeVerification, verifierStats, type VerificationSummary } from '../../tools/verifier-config';

test('verifier is off unless GRAPHENTRA_VERIFY_REPORT=1, even with a key', () => {
  assert.deepEqual(readVerifierConfig({}), { enabled: false });
  assert.deepEqual(readVerifierConfig({ OPENAI_API_KEY: 'sk-test', GRAPHENTRA_VERIFY_REPORT: 'true' }), { enabled: false });
});

test('switched on, it needs a key and uses the V-3 threshold by default', () => {
  assert.throws(() => readVerifierConfig({ GRAPHENTRA_VERIFY_REPORT: '1' }), /OPENAI_API_KEY/);
  assert.throws(() => readVerifierConfig({ GRAPHENTRA_VERIFY_REPORT: '1', OPENAI_API_KEY: '  ' }), /OPENAI_API_KEY/);
  assert.deepEqual(readVerifierConfig({ GRAPHENTRA_VERIFY_REPORT: '1', OPENAI_API_KEY: 'sk-test' }), { enabled: true, apiKey: 'sk-test', threshold: 0.7 });
});

test('threshold override is validated', () => {
  const env = { GRAPHENTRA_VERIFY_REPORT: '1', OPENAI_API_KEY: 'sk-test' };
  assert.deepEqual(readVerifierConfig({ ...env, GRAPHENTRA_VERIFIER_THRESHOLD: ' 0.6 ' }), { enabled: true, apiKey: 'sk-test', threshold: 0.6 });
  for (const bad of ['0', '1', '-0.2', 'abc', '1.5']) {
    assert.throws(() => readVerifierConfig({ ...env, GRAPHENTRA_VERIFIER_THRESHOLD: bad }), /between 0 and 1/, bad);
  }
});

const verification: ReportVerification = {
  verification: {
    threshold: 0.7,
    notCovered: 3,
    entries: [
      { id: 'coverage:a', kind: 'coverage', entity: 'a', score: 0.9, verdict: 'covered', reason: 'ok' },
      { id: 'coverage:b', kind: 'coverage', entity: 'b', score: 0.2, verdict: 'not_covered', reason: 'low_score' },
      // Folded into b: copies b's answer, must not count twice.
      { id: 'coverage:b.inner', kind: 'coverage', entity: 'b.inner', foldedInto: 'b', score: 0.2, verdict: 'not_covered', reason: 'low_score' },
      { id: 'coverage:c', kind: 'coverage', entity: 'c', score: null, verdict: 'not_covered', reason: 'refusal' },
      { id: 'coverage:d', kind: 'coverage', entity: 'd', score: null, verdict: 'skipped', reason: 'no_behaviour_change' },
      { id: 'faithfulness:0', kind: 'faithfulness', score: null, verdict: 'not_covered', reason: 'error' },
    ],
  },
  usage: { inputTokens: 1000, cachedTokens: 400, outputTokens: 20 },
  durationMs: 1500,
  plainChecks: { checks: [{ text: 'Check b', entities: ['b'] }], untestable: [], fallback: ['c'], usage: { promptTokens: 300, completionTokens: 50, calls: 1 }, durationMs: 900, error: undefined },
};

test('summary counts asked questions once and keeps no question text', () => {
  const summary = summarizeVerification(verification);
  assert.deepEqual(summary, {
    threshold: 0.7,
    questions: 4,
    answered: 2,
    notCovered: 3,
    coverageGaps: 2,
    faithfulnessFlags: 1,
    skipped: 1,
    refusals: 1,
    errors: 1,
    missing: 0,
    meanScore: 0.55,
    minScore: 0.2,
    durationMs: 1500,
    usage: { inputTokens: 1000, cachedTokens: 400, outputTokens: 20 },
    plainChecks: { checks: 1, fallback: 1, untestable: 0, promptTokens: 300, completionTokens: 50, durationMs: 900, failed: false },
  });
});

test('stats over no verified reports are empty, not zero rates', () => {
  const stats = verifierStats(4, []);
  assert.equal(stats.reports, 4);
  assert.equal(stats.verifiedReports, 0);
  assert.equal(stats.gapRate, null);
  assert.equal(stats.notCovered.median, null);
  assert.equal(stats.durationMs.p95, null);
});

test('stats give gap rate, list length, failed answers, tokens and latency', () => {
  const base = summarizeVerification(verification);
  const clean: VerificationSummary = { ...base, notCovered: 0, refusals: 0, errors: 0, meanScore: 0.95, durationMs: 500, plainChecks: undefined };
  const long: VerificationSummary = { ...base, notCovered: 9, refusals: 0, errors: 0, meanScore: 0.35, durationMs: 4000, plainChecks: { ...base.plainChecks!, failed: true } };
  const stats = verifierStats(5, [base, clean, long]);
  assert.equal(stats.verifiedReports, 3);
  assert.equal(stats.reportsWithGaps, 2);
  assert.equal(stats.gapRate, 0.667);
  assert.deepEqual(stats.notCovered, { total: 12, median: 3, p90: 9, max: 9 });
  assert.equal(stats.notCoveredAtMost3Rate, 0.667);
  assert.equal(stats.meanScore, 0.617);
  assert.equal(stats.refusals, 1);
  assert.equal(stats.reportsWithFailedAnswers, 1);
  assert.deepEqual(stats.durationMs, { p50: 1500, p95: 4000 });
  assert.equal(stats.usage.inputTokens, 3000);
  assert.equal(stats.usage.plainCheckPromptTokens, 600);
  assert.equal(stats.plainCheckFailures, 1);
});

test('nearest-rank percentile', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([4, 1, 3, 2], 100), 4);
});
