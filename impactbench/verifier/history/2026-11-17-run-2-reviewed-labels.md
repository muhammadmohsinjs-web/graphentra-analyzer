# Run 2 · 2026-11-17 · Reviewed labels (U1 + U3), OpenAI Decisions vs current judge

**Phase V, Chunk 1 (V-2), input to V-3.** This run rescores the Run 1 answers on reviewed labels only. No model was called again. The answers in `results/` are unchanged and the inputs (`inputHash`) did not change. Only labels changed.

| | |
|---|---|
| Question | Can a Decisions API checker tell when a QA report misses a change? (ADR-0011, E5) |
| Gate | Recall ≥ 0.90 for the flag and precision ≥ 0.60, at one threshold |
| Labelled set | `labels.jsonl`, sha256 `e8568ebad47d…`, **99 of 150 reviewed** (Run 1: `b9b4d3fcaf08…`, 0 reviewed) |
| Scope | U1 coverage (60) + U3 faithfulness (39). **U2 is excluded**: Run 1 showed it fails for both candidates and it is proposed to be dropped, so its 50 items stay drafts. |
| Command | `verifier-spike.mts score --reviewed-only` |
| Review sheet | `review-first-pass.md` |

## How the labels were reviewed

| Group | Items | How | Changed |
|---|---|---|---|
| Coverage `judge-area` negatives | 15 | First pass, reading report against code (Claude); suggestions accepted by the owner | 13 → true, 2 stay false |
| Faithfulness `draft-own-report` | 20 | First pass by an independent agent reading claim against BEFORE/AFTER; accepted by the owner | 2 → false (consola-02, consola-03); 1 unsure (excalidraw-10) left unreviewed and excluded |
| Cross-commit and inversions | 35 | False by construction | none |
| Coverage `judge-area` positives | 30 | Accepted on skim: the regression area is covered, so the change is too | none |
| Trigger (U2) | 50 | Not reviewed | excluded |

No model answers were looked at while making the suggestions. Each reviewed item's `reason` starts with or ends in `Review 2026-11-17`, so the method can be traced per item.

Reviewed set: coverage 43 true / 17 false; faithfulness 18 true / 21 false. **38 items should be flagged.**

## Results

| | OpenAI Decisions | Current judge |
|---|---|---|
| Gate | **PASS** at t=0.7: recall 92 % (35/38), precision 92 % | **PASS** at every threshold: recall 92 %, precision 100 % |
| Coverage (U1) R / P | 100 % / 85 % | 94 % / 100 % |
| Faithfulness (U3) R / P | 86 % / 100 % | 91 % / 100 % |
| Brier | 0.064 (Run 1: 0.251) | 0.029 (Run 1: 0.201) |
| Refusals / errors | 0 / 0 | 0 / 0 |
| Cost, 99 items | ≈ $0.014 (estimated) | $0.25 |
| Latency p50 / p95 | 1.8 s / 2.8 s | 28 s / 122 s |

OpenAI by threshold (recall / precision of the flag): 0.3 → 82 / 94 · 0.4–0.6 → 85 / 92–94 · **0.7 → 92 / 92**.

Missed items (should be flagged, were not):

| Item | OpenAI p | Judge p | Note |
|---|---|---|---|
| `faithfulness:consola-02:v2-base-1:0` | 0.99 | 0.95 | Relabelled false in this review (medium confidence). Both candidates call it supported. |
| `faithfulness:consola-03:v2-base-1:0` | 0.95 | 0.95 | Same as above. |
| `faithfulness:excalidraw-13:v2-base-1-inv:3` | 0.81 | flagged | A hand inversion OpenAI accepts at t=0.7. |
| `coverage:excalidraw-03:v1-lookup-always-2` | flagged | 0.90 | Judge only. |

## Assessment

1. **The Run 1 hypothesis held.** Run 1's U1 misses were label errors: 13 of the 15 `judge-area` negatives describe the change and were relabelled true. With correct labels both candidates catch every cross-commit item, and OpenAI catches all 17 real coverage gaps.
2. **U1 + U3 pass the E5 gate with OpenAI Decisions at t=0.7.** Recall 92 %, precision 92 %, about 18× cheaper and 15× faster than the judge.
3. **The pass is narrow.** 35 of 38 flags; one more miss gives 34/38 = 89 % and a FAIL. OpenAI only reaches the gate at t=0.7. Between 0.4 and 0.6 it sits at 85 %. The threshold must be 0.7, and a repeat run is needed before relying on the margin.
4. **Two of the three OpenAI misses are labels where the reviewer was unsure.** Both candidates disagree with the new `false` on consola-02 and consola-03, and both are about how strictly "now" and "default export" are read. If those two are true, OpenAI recall is 35/36 = 97 %. This should be settled by checking the package entry points in the consola repo, not by the model answers.
5. **U3's real weak spot is subtle inversions.** OpenAI let one hand-swapped claim through at p=0.81 (excalidraw-13, an equal-width boundary case). Faithfulness recall is 86 % alone. It passes only combined with U1.
6. U2 is unchanged from Run 1: it fails and is out of scope for this gate.

## Proposed V-3 decision (to write into ADR-0011)
- **Go for U1 + U3** with OpenAI Decisions (`gpt-6-luna`), threshold **0.7**, with recall-first handling (refusal or error = flag).
- **Drop U2 as a yes/no question.** Open a separate spike for "the writer names the risky inputs and the verifier checks they appear in a QA check".
- Conditions: settle consola-02/03 labels, and repeat the OpenAI run at least twice to measure variance before Chunk 2 depends on the margin.

## Caveats
- The first-pass labels were written by Claude and an agent, then accepted by the owner without line-by-line edits. The 30 skim-accepted positives were not read.
- 99 items, single run. A 3-item swing changes the verdict.
- The OpenAI cost is still an estimate.
- `excalidraw-10` (claim, unsure) and all 50 U2 items are excluded.

## Next
1. Check consola-02/03 against the consola repo's package entry points and fix the two labels if needed.
2. Rerun OpenAI twice (`run --provider openai --force`), score, and record it as Run 3.
3. Write the V-3 decision into ADR-0011. Chunk 2 starts after that.
