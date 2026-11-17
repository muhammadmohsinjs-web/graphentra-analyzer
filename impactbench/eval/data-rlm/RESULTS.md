# Large-payload experiment: RLM vs fan-out vs budget vs lossless compaction

Run 2026-11-17 on branch `eval/rlm-fanout` (from `eval/corpus32-lookup-tool` 1562a02). Commits: excalidraw-19 (3.0 MB payload) and
excalidraw-20 (4.9 MB), the two that failed outright in the corpus-32 run (over the context window / over the 8 MB provider limit).
Report model `openai/gpt-6-luna`, judge `deepseek/deepseek-v4-pro-0813`, 3 runs per variant per commit, 24 reports, $1.06 total.
Code: `tools/impactbench-large-payload.mts`; rows: `runs.jsonl`.

## Variants

| Variant | What the model gets |
|---|---|
| compact | Lossless re-encoding: one entity table; paths as ID lists; drops `typedPath` and the production/test dependent copies |
| budget | compact, then deepest/least certain paths and blast entities cut round-robin to 250 KB |
| fanout | compact changes packed into ~200 KB chunks; one findings call per chunk; one merge call writes the report |
| rlm | Root model sees an index; explores `evidence` with JS in a REPL and calls `llm(question, data)` on slices (10 rounds, 24 sub-calls) |

## Payload size

| Commit | Original | compact | budget | Truth IDs kept (budget) |
|---|---|---|---|---|
| excalidraw-19 | 3049 KB | 890 KB | 230 KB | 4/4 |
| excalidraw-20 | 4857 KB | 1299 KB | 210 KB | 3/3 |

Blast-radius paths were 72 to 75% of the payload: each path repeated full entity objects plus a `typedPath` string saying the same thing.
Changed code itself is 14 to 32 KB.

## Results

| Variant | Valid | Caught | Findings caught (before merge) | Mean cost | Mean time |
|---|---|---|---|---|---|
| compact | 6/6 | 0/6 | - | $0.040 | 2.4 min |
| budget | 6/6 | 0/6 | - | $0.010 | 1.8 min |
| fanout | 6/6 | 0/6 | 1/6 | $0.051 | 8.0 min |
| rlm | 6/6 | 1/5 (1 judge error) | 1/6 | $0.076 | 20.5 min |

Baseline (corpus-32 run): 0/2 valid; both failed before producing a report.

## Observations

1. Every variant fixes the hard failure. Lossless compaction alone brings both commits inside the context window; the budget makes them cheap.
2. No variant reliably catches these bugs. All 24 reports named the right area and tested the wrong input, the same failure seen across the corpus.
3. RLM's one catch (excalidraw-19 run 2) came from a check on the focus indicator being absent near the endpoint; the judge accepted it but
   noted the report never explains the endpoint-drag conflict. One sample on a hard case; not evidence of an advantage.
4. RLM mostly did not delegate: `llm()` sub-calls per run were 0, 3, 8, 1, 3, 21. The root paged through diffs with `print` instead, like the
   lookup tool's re-reads. It was also 8 to 10x slower than one call, and 1.5 to 2x the cost.
5. Fan-out lost a catch in the merge: excalidraw-19 run 3's findings exposed the bug and the merged report dropped it. The 5-area cap is a
   recall limit.
6. Run under concurrency 4, fanout and rlm times grew from 2 and 3.5 min (alone) to 7 to 32 min, likely provider rate limits.

## Recommendation

Ship lossless compaction now (no recall cost, 3.5x smaller). Add the budget only above the context window, with an explicit truncation note.
Do not adopt RLM for the QA report. If fan-out is pursued, the merge must keep every high-risk finding's triggering input instead of capping
at five areas. The catch rate is still the problem to solve, and it is not a context-size problem.
