# Run 1 · 2026-11-17 · Draft labels, OpenAI Decisions vs current judge

**Phase V, Chunk 1 (V-1, V-2).** This is the first spike run. Labels are **drafts (0 of 150 reviewed)**, so this run gives no gate decision. It is recorded so later runs can be compared with it.

| | |
|---|---|
| Question | Can a Decisions API checker tell when a QA report misses a change? (ADR-0011, E5) |
| Gate | Recall ≥ 0.90 for "not covered" and precision ≥ 0.60, at one threshold |
| Branch / base | `eval/phase-v-spike` from `eval/corpus32-lookup-tool` @ `1562a02` |
| Labelled set | `labels.jsonl`, 150 items, sha256 `b9b4d3fcaf08…`, 0 reviewed |
| Candidates | OpenAI Decisions (`gpt-6-luna`, `POST /v1/decisions`) · current ImpactBench judge (`deepseek/deepseek-v4-pro-0813` via OpenRouter) |
| Not run | Google Decisions (no `GEMINI_API_KEY`) |
| Raw answers | `results/openai.jsonl`, `results/judge.jsonl` |
| Commands | `verifier-labels.mts build`, `verifier-spike.mts run --provider openai|judge`, `verifier-spike.mts score` |

## The labelled set

| Kind | Items | true / false | Label sources |
|---|---|---|---|
| Coverage (U1) | 60 | 30 / 30 | judge-area 45, cross-commit 15 |
| Triggering input (U2) | 50 | 25 / 25 | judge-catch 50 |
| Faithfulness (U3) | 40 | 20 / 20 | draft-own-report 20, cross-commit 10, inversion 10 |

Reports come from `data-v2` (current baseline) and `data` (v1 variants). There are 22 to 28 distinct commits per kind. Inputs are compact (report plus change summary), and the largest is 24 KB.

## Results

| | OpenAI Decisions | Current judge |
|---|---|---|
| Gate overall | **FAIL** (best recall 63 % / precision 72 % at t=0.7) | **FAIL** (recall 60 % / precision 92 %, same at every threshold) |
| Brier score | 0.251 | 0.201 |
| Refusals / errors | 1 / 0 | 0 / 5 (empty output: the reasoning used the whole 4,000-token budget) |
| Cost, 150 items | ≈ $0.02 (estimated from the chat price; Decisions pricing is not published) | $0.44 (reported by OpenRouter, with retries) |
| Latency p50 / p95 | 1.8 s / 2.7 s | 31 s / 164 s |

Recall / precision of the flag, per kind, at t=0.7:

| Kind | OpenAI Decisions | Current judge |
|---|---|---|
| Faithfulness (U3) | 95 % / 95 % | 100 % / 100 % |
| Coverage (U1) | 60 % / 90 % | 53 % / 100 % |
| Triggering input (U2) | 40 % / 40 % | 36 % / 69 % |

Flags per label source at t=0.7. "neg" means the item should be flagged; "pos" means it should not:

| Kind · source | OpenAI neg / pos flagged | Judge neg / pos flagged |
|---|---|---|
| Coverage · cross-commit | 15/15 · – | 15/15 · – |
| Coverage · judge-area | 3/15 · 2/30 | 1/15 · 0/30 |
| Trigger · judge-catch | 10/25 · 15/25 | 9/25 · 4/25 |
| Faithfulness · cross-commit | 10/10 · – | 10/10 · – |
| Faithfulness · inversion | 9/10 · – | 10/10 · – |
| Faithfulness · draft-own-report | – · 1/20 | – · 0/20 |

OpenAI probabilities are mostly extreme: 82 of 149 answers are above 0.8 and 41 are below 0.2. Moving the threshold between 0.3 and 0.7 changes little. The judge answers with only two confidence levels, so its threshold has no effect.

## Assessment

1. **Faithfulness (U3) works with both candidates.** Every claim taken from another commit was flagged, and 9/10 (OpenAI) and 10/10 (judge) hand-swapped before/after claims were flagged. Only one true claim was flagged. This part of the verifier is ready to build.
2. **Coverage (U1) is probably fine, and the misses look like label errors.** Both candidates flagged all 15 cross-commit items. Almost all misses are the 15 `judge-area` negatives, which both models call covered, many at p=1.00. The draft rule took the ImpactBench judge's `area` flag as "not covered", but `area` means "the report points at the *regression's* user-visible area", not "the report covers this *change*". Most of these 15 should probably be true. This needs the label review before it counts.
3. **Triggering input (U2) fails for both candidates, so the question is the problem, not the vendor.** OpenAI flags 15 of 25 reports that *do* catch the bug and only 10 of 25 that miss it, which is no better than chance. The judge is more precise (69 %) but catches only 36 % of misses. Example: consola-01. The report tests "repeated logs, then a different log", and the bug only shows when no different log follows. OpenAI answers p=0.98 "uses the triggering input". A yes/no question cannot find the risky input when the model must first work it out from the code. This is the "right area, wrong input" pattern behind most of the 22/31 misses, so **the verifier as designed will not raise E1 (catch rate)** through U2.
4. **OpenAI Decisions is the better tool for U1 and U3.** It has similar accuracy, costs about 20× less and is about 15× faster than the judge, with no parse errors.
5. **OpenRouter does not proxy OpenAI's `/v1/decisions`.** Its `/api/alpha/decisions` is a different product. The verifier needs its own `OPENAI_API_KEY` (this settles the ADR-0011 open question).

## Proposed direction (to confirm at V-3, after review)
- Accept ADR-0011 for **U1 + U3** with OpenAI Decisions. Pick the threshold from the reviewed run. Given the extreme probabilities, 0.7 is the likely pick.
- **Drop U2 as a yes/no question.** Rework it so the writer names the risky inputs per change (or a deterministic step derives them), and the verifier checks only that each named input appears in a QA check. Measure that as a new spike before building it.
- Re-check E1 expectations: without U2, Phase V mainly guards against omissions (E3) and false claims, not wrong inputs.

## Caveats
- All labels are drafts. `judge-catch` and `judge-area` labels come from the same judge family as one candidate, which may favour the judge.
- The OpenAI cost is an estimate. Check it against the invoice.
- A single run, with no repeat runs, so variance is unknown.
- The judge's 5 empty outputs count as flags (recall-first), which lowers its precision slightly.

## Next
1. Review `labels.jsonl`, starting with the 15 `judge-area` coverage negatives and the 20 `draft-own-report` claims. Set `"reviewed": true` on each.
2. Run `verifier-spike.mts score --reviewed-only`, record it as Run 2 in this folder, and decide V-3 in ADR-0011.
3. Optional: add `GEMINI_API_KEY` and run `--provider google` for the vendor comparison.
