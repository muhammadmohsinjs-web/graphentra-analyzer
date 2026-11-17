# Verifier answer key and spike (Phase V, Chunk 1)

This folder answers one question before any verifier code is built: **can a Decisions API checker tell when a QA report misses a change?** (ADR-0011, gate E5: recall ≥ 0.90 for "not covered", precision ≥ 0.60.)

| File | Task | What it is |
|---|---|---|
| `labels.jsonl` | V-1 | The labelled set. One item per line, each with its own compact verifier input. |
| `inversions.json` | V-1 | Hand-written before/after-swapped claims (faithfulness negatives). |
| `results/<provider>.jsonl` | V-2 | Raw answers per candidate: probability, refusal or error, tokens, cost, latency. |
| `SPIKE.md` | V-2 | Generated score tables and the V-3 gate result (overwritten on every `score`). |
| `history/` | V-2, V-3 | One dated assessment per run, kept for comparison. Add a new file per run; never edit an old one. |

## Run history

| Date | Run | Labels | Result |
|---|---|---|---|
| 2026-11-17 | [Run 1](history/2026-11-17-run-1-draft-labels.md) | 150 drafts, 0 reviewed | Gate FAIL for both candidates. U3 works, U1 likely works after review, U2 fails for both. |
| 2026-11-17 | [Run 2](history/2026-11-17-run-2-reviewed-labels.md) | 99 reviewed (U1 + U3; U2 excluded) | Gate PASS for both. OpenAI at t=0.7: recall 92 %, precision 92 %. Narrow margin (35/38). |

## Commands

```bash
# 0. Evidence for corpus-32 (large; keep <work> outside the repo). <history> holds full clones of the 6 corpus repos.
node --import tsx tools/impactbench-report-eval.mts evidence --history <history> --work <work> --data <scratch>
# 1. Build or refresh the labelled set (reviewed items are kept as they are)
node --import tsx tools/verifier-labels.mts build --work <work>
node --import tsx tools/verifier-labels.mts stats
# 2. Ask each candidate, then score. Needs OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY in .env
NODE_USE_ENV_PROXY=1 node --import tsx tools/verifier-spike.mts run --provider openai
NODE_USE_ENV_PROXY=1 node --import tsx tools/verifier-spike.mts run --provider google
NODE_USE_ENV_PROXY=1 node --import tsx tools/verifier-spike.mts run --provider judge
node --import tsx tools/verifier-spike.mts score --reviewed-only
```

`--provider fake` runs a noisy oracle offline, which is useful to check the pipeline. Its results file is not committed.

## Item format

```json
{"id":"trigger:consola-01:v2-base-1","kind":"trigger","commit":"consola-01","repo":"consola","report":"v2-base-1",
 "entity":"src/consola.js#Consola._logFn","question":"…","input":"QA REPORT …\n\nCHANGE … BEFORE … AFTER …",
 "label":false,"reason":"Judge: no check uses the triggering input. …","labelSource":"judge-catch","reviewed":false}
```

- `label: true` means covered, triggering input present, or supported. **The verifier flags `label: false` items.** Recall and precision are measured on the flag.
- `input` is the compact verifier input from ADR-0011: the report, plus the change summary (entity, BEFORE = removed code, AFTER = added code, up to 3 "used by" paths). It is never the full graph. Code is capped at 4,000 characters per side, and faithfulness evidence at 24,000 characters.
- `report` is `<data set>-<variant>-<run>`. `v2` is `impactbench/eval/data-v2/runs.jsonl` (the current baseline) and `v1` is `impactbench/eval/data/runs.jsonl`. Suffixes: `-x-<commit>` marks a cross-commit construction, and `-inv` a hand-written inversion.

## How draft labels are made (`labelSource`)

| Kind | Source | Label rule |
|---|---|---|
| coverage (U1) | `judge-area` | The commit's own changed truth entity (fault first). The ImpactBench judge's `area` decides: true if the report points the tester at the affected area. |
| coverage (U1) | `cross-commit` | The report of commit A, asked about the changed truth entity of commit B in the same repo, with no shared entity or area. This is always **false**. |
| trigger (U2) | `judge-catch` | The ImpactBench judge's `catch`: true if a QA check, with its stated input, would fail on the build that has the regression. |
| faithfulness (U3) | `draft-own-report` | The first key change of a valid v2 report, checked against its own evidence. Drafted **true**; the reviewer must confirm it against the code. |
| faithfulness (U3) | `cross-commit` | The first key change of another commit in the same repo. This is always **false**. |
| faithfulness (U3) | `inversion` | A real key change with before and after swapped by hand (`inversions.json`). This is always **false**. |

### Why U2 is labelled from the regression, not from "old and new differ"
In consola-01 the report's check sends a distinct log after the interval. Old and new code *do* differ on that input (that is the intended change), but the regression (a burst with no follow-up log never prints its count) is not exercised. A literal "is there an input where old and new differ" question would answer yes and the bug would ship. What the phase must predict is whether QA would catch the bug, so the label is `catch`, and the question asks the model to look for unintended differences and edge cases. If no candidate can predict this, U2 fails the gate on its own, and that is a valid finding.

## Review (needed before the V-3 gate)
1. Open `labels.jsonl`. For each item, read `input` and `question`, then check `label` and `reason`.
2. Fix the label or reason if needed, and set `"reviewed": true`.
3. Rebuild if the inputs change. Reviewed items keep their label and reason.
4. Score with `--reviewed-only`. `SPIKE.md` warns while drafts remain.

Watch for these cases while reviewing: `judge-area` negatives where the report still covers the change in other words (relabel to true), and `draft-own-report` claims that overstate or swap the code (relabel to false).
