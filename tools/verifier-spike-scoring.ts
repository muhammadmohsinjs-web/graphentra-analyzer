// Phase V · V-2: pure scoring for the verifier spike (tools/verifier-spike.mts). A plain .ts module so the CommonJS
// typecheck (tsconfig.root.json) and its unit test can import it; the .mts script is ES-module only.

export const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7];
export const GATE = { recall: 0.9, precision: 0.6 };

export type Scored = { label: boolean; p: number | null };
/** Flag = "not covered / not supported". Recall-first: no answer is a flag. */
export const flagged = (s: Scored, t: number) => s.p === null || s.p < t;
export function prf(list: Scored[], t: number) {
  const tp = list.filter(s => !s.label && flagged(s, t)).length;
  const flags = list.filter(s => flagged(s, t)).length;
  const negatives = list.filter(s => !s.label).length;
  return { t, tp, flags, negatives, recall: negatives ? tp / negatives : NaN, precision: flags ? tp / flags : NaN };
}
export function brier(list: Scored[]) {
  const answered = list.filter(s => s.p !== null);
  return answered.length ? answered.reduce((sum, s) => sum + (s.p! - Number(s.label)) ** 2, 0) / answered.length : NaN;
}
export function reliability(list: Scored[], bins = 5) {
  return Array.from({ length: bins }, (_, b) => {
    const lo = b / bins; const hi = (b + 1) / bins;
    const inBin = list.filter(s => s.p !== null && s.p >= lo && (s.p < hi || (b === bins - 1 && s.p <= hi)));
    return { lo, hi, n: inBin.length, meanP: inBin.length ? inBin.reduce((a, s) => a + s.p!, 0) / inBin.length : NaN, fracTrue: inBin.length ? inBin.filter(s => s.label).length / inBin.length : NaN };
  });
}
/** The V-3 pick: among thresholds that meet the gate, the best precision; ties go to higher recall, then the lower threshold. */
export function gatePick(list: Scored[]) {
  const passing = THRESHOLDS.map(t => prf(list, t)).filter(r => r.recall >= GATE.recall && r.precision >= GATE.precision);
  return passing.sort((a, b) => b.precision - a.precision || b.recall - a.recall || a.t - b.t)[0];
}
