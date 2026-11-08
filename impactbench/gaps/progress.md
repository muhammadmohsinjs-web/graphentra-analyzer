# Progress by commit

One section per corpus commit we worked on: what failed at the start, what we changed, what improved, and what is still open.
`gaps.json` holds the cause and the evidence for each gap. This file is the running story, so add a new section for each commit and
update the table when numbers change. Do not delete old results; add a dated line instead.

| Commit | Gap | Start | Now | State | Last updated |
|---|---|---|---|---|---|
| excalidraw-11 | GAP-001 (analyzer), GAP-003 (report) | Analyzer missed the receiver. Report caught the bug 5 of 9, explained 1 of 9. | Analyzer finds it. Report catches 18 of 20 and 19 of 20 (two shipped variants), explains almost all of those. | Improved on this commit only. GAP-003 open. | 2026-11-08 |

---

## excalidraw-11: "feat: changed text copy/paste behaviour (#5786)"

**The bug.** The commit replaces every tab in pasted text with four spaces. `tryParseSpreadsheet` decides a paste is a spreadsheet by
splitting on tabs, so after the commit, pasting spreadsheet cells no longer offers the chart. Fixed upstream three weeks later.

### Where we started
1. The analyzer did not report the chart code at all. It receives the changed value but does not call the changed function, so the
   caller walk never reached it. (GAP-001)
2. Once the analyzer found it (`receivesChangedValue`), the QA report still missed the bug. The receiver was one of 39 unranked entries,
   had no description, and the prompt never asked what relied on the old behaviour. (GAP-003)
3. Measured on this commit with deepseek/deepseek-v4.1-flash-1017, judged per check by openai/gpt-5.6-luna:
   - old payload: 9 valid reports, 5 caught the bug, 1 explained why
   - payload as of GAP-001 fix ("base"): 9 valid, 5 caught, 4 explained

### What we changed
| Change | Where |
|---|---|
| Follow changed values to the code that receives them (done before this work) | `packages/analyzer/src/value-flow.ts` |
| New check: a receiver splits or searches on a character the change removes (`reliesOnRemovedCharacters`; tab, newline, carriage return, comma, semicolon, pipe; one call down) | `packages/analyzer/src/value-flow.ts`, `contracts.ts`, both `evidence.schema.json` copies |
| Rank receivers (conflict first, specific code in other files before generic helpers), cap at 8, note how many were left out | `packages/reporting/src/context-pack.ts` |
| Meaning of each receiver from file summaries, plus a plain sentence for the conflict | `packages/reporting/src/context-pack.ts` |
| Prompt rule: treat a conflict as the most likely regression and add a check that uses input that relied on the old behaviour | `packages/reporting/src/qa-evidence.ts` |

### Results (experiment harness, 8 to 20 runs per variant)
Columns: valid reports / caught the bug / explained the cause.

| Variant | Valid | Caught | Explained |
|---|---|---|---|
| old | 9 | 5 | 1 |
| base | 9 | 5 | 4 |
| meaning only | 10 | 9 | 3 |
| code snippets | 6 (4 failed) | 2 | 2 |
| guarantees list | 10 | 7 | 8 |
| audit second pass | 6 (4 failed) | 6 | 4 |
| conflict only | 9 | 8 | 9 |
| everything | 8 | 7 | 8 |
| conflict + meaning | 18 (2 no report) | 18 | 18 |
| conflict + meaning + guarantees | 18 (2 no report) | 18 | 18 |

Shipped code, end to end, 20 runs each: base 20 valid, 18 caught, 20 explained; meaning 19 valid, 19 caught, 19 explained (1 failed).
In plain terms: about 90 to 95 percent of runs, against about 55 percent before.

The analyzer scan of all 32 corpus commits: the new note fires once (excalidraw-11) and flags nothing else.

### Still open and not proven
- One commit only, and we tuned on it, so the numbers are optimistic. Nothing was tested on a commit we had not already seen.
- The report was not run on the other 31 commits. GAP-003 stays open until we have whole-corpus numbers (see the rule in `README.md`).
- About 5 to 10 percent of runs return no usable report (empty, or rejected by the identifier-leak check).
- The check covers six characters and one call down. It is a warning, not a verdict.
- Results come from one report model (DeepSeek) and one judge. Another model could give different numbers.

### Next
1. Run the report on all 32 commits with the shipped code, with and without the conflict note, to get corpus numbers and see whether
   the prompt change hurts any other commit. About $3 to 5 and 1.5 to 2 hours.
2. Retry or repair empty and rejected reports.
3. Only then update GAP-003 (status, `fixedIn`, whole-corpus numbers) and run `npm run bench:gaps -- check`.
4. Pick the next commit from `npm run bench:gaps -- summary` and add a section below in the same shape: start, changes, results, open.

Raw runs and the harness live outside the repo in the session scratchpad. If you want them kept, copy `runs.jsonl` into
`impactbench/gaps/data/` before the next session.
