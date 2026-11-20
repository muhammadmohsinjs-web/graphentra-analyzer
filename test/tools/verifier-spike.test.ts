import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brier, flagged, gatePick, prf, reliability } from '../../tools/verifier-spike-scoring';

test('no answer is a flag (recall-first)', () => {
  assert.equal(flagged({ label: true, p: null }, 0.5), true);
  assert.equal(flagged({ label: true, p: 0.49 }, 0.5), true);
  assert.equal(flagged({ label: true, p: 0.5 }, 0.5), false);
});

test('recall and precision count label=false as the positive class', () => {
  const list = [{ label: false, p: 0.1 }, { label: false, p: 0.8 }, { label: true, p: 0.2 }, { label: true, p: 0.9 }, { label: false, p: null }];
  const r = prf(list, 0.5);
  assert.equal(r.tp, 2); assert.equal(r.flags, 3); assert.equal(r.negatives, 3);
  assert.equal(r.recall, 2 / 3); assert.equal(r.precision, 2 / 3);
});

test('brier ignores unanswered items; reliability puts p=1 in the last bin', () => {
  assert.equal(brier([{ label: true, p: 1 }, { label: false, p: 0.5 }, { label: true, p: null }]), 0.125);
  const bins = reliability([{ label: true, p: 1 }, { label: false, p: 0 }]);
  assert.equal(bins[4].n, 1); assert.equal(bins[0].n, 1);
});

test('gate picks the passing threshold with the best precision, or nothing', () => {
  const good = [...Array(9)].map(() => ({ label: false, p: 0.2 })).concat([{ label: false, p: 0.65 }], [...Array(10)].map(() => ({ label: true, p: 0.9 })));
  assert.equal(gatePick(good)?.t, 0.7);
  assert.equal(gatePick([{ label: false, p: 0.9 }, { label: true, p: 0.1 }]), undefined);
});
