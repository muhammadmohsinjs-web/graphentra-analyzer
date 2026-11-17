# Run 3 · 2026-11-17 · OpenAI repeats and the consola label check

**Phase V, Chunk 1 (V-2), the last input to V-3.** This run settles the two open conditions from Run 2: the doubtful consola labels, and run-to-run variance for OpenAI Decisions.

| | |
|---|---|
| Labelled set | `labels.jsonl`, 99 of 150 reviewed (same scope as Run 2: U1 + U3, U2 excluded) |
| New results | `results/openai-repeat-2.jsonl`, `results/openai-repeat-3.jsonl`: two fresh `run --provider openai` passes over all 150 items. `results/openai.jsonl` is Run 1, unchanged. |
| Command | `verifier-spike.mts score --reviewed-only` (SPIKE.md now lists all three OpenAI runs) |

## 1. consola-02 and consola-03 labels, checked in the consola repo

| Item | Check | Result |
|---|---|---|
| `faithfulness:consola-02:v2-base-1:0`, claim: "the default export changes from the logger class to an initialized instance" | `ef6e5e5^`: `package.json` main/exports point to `dist/consola.node.*`. `src/consola.node.ts:50` is `export default globalThis.consola`, which is an instance. | **False, confirmed (high).** The package default was already an instance. Only the internal `src/consola.ts` default-exported the class. |
| `faithfulness:consola-03:v2-base-1:0`, claim: "instances can now be created with caller-supplied options, including custom reporters, while retaining env-based defaults" | `cf93d42^`: `src/index.ts` already re-exported `createConsola(options)` from `index.shared`. The commit adds a package-level `createConsola(options)` that falls back to env-based reporters. | **False, kept (medium).** "Can now" claims a capability that already existed. The second half is right, so this one is borderline. |

The two labels stay false. Both candidates call both claims supported (p ≥ 0.95), so these are real misses, not label noise. Both are the same failure type: **a claim that calls something new when it already existed.** The verifier input shows the diff, not the prior state of the package, so the model cannot see that the capability was already there.

## 2. Run-to-run variance (three OpenAI runs)

| Run | Gate at t=0.7 | Recall | Precision | Misses |
|---|---|---|---|---|
| Run 1 (`openai`) | PASS | 92 % (35/38) | 92 % | consola-02, consola-03, excalidraw-13 inversion |
| Repeat 2 | PASS | 92 % | 92 % | same three |
| Repeat 3 | PASS | 92 % | 92 % | same three |

**The probabilities are identical across all three runs** (maximum spread 0.00 on every reviewed item; no item changes its flag at any threshold). Latency differed between runs (p50 1.8 s, 1.3 s, 1.2 s) and the third run reported cached input tokens, so these were real calls. OpenAI Decisions is deterministic for the same input.

## Assessment

1. **Run-to-run variance is not a risk.** The same input gives the same answer. The Run 2 margin does not depend on luck between runs.
2. **The remaining risk is sample size, not noise.** 35 of 38 flags; one more real miss in a larger set would drop recall below 90 %. Only a bigger labelled set reduces this risk, and repeat runs cannot.
3. **The known weak spot is "new vs already existed".** Two of three misses are claims that call an old capability new. A cheap guard in Chunk 2 is to give U3 the BEFORE state of the touched module's exports, not only the diff. The third miss is a subtle boundary inversion (excalidraw-13).
4. Determinism also means a fixed answer key can serve as a regression test for the verifier prompt in Chunk 2.

## V-3 decision (ready to write into ADR-0011)
- **Go for U1 + U3** with OpenAI Decisions (`gpt-6-luna`), threshold **0.7**, recall-first (refusal or error = flag). Measured: recall 92 %, precision 92 %, about $0.014 per 99 items (estimated), p50 1.2–1.8 s, deterministic.
- **Drop U2 as a yes/no question.** Run a separate spike in which the writer names the risky inputs and the verifier checks they appear in a QA check.
- **Carry into Chunk 2:** add BEFORE-state context for U3 "now/new" claims, and grow the labelled set before tightening the gate claim.

## Caveats
- Same label caveats as Run 2: first-pass labels accepted without line-by-line edits, 30 positives skim-accepted, excalidraw-10 and U2 excluded.
- The OpenAI cost is still an estimate.
