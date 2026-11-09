# Corpus-32 evaluation report: analyzer, QA report, and the lookup tool

Run on 2026-11-09, branch `eval/corpus32-lookup-tool` (from `dev` 983bc19). Plan: [`PLAN.md`](PLAN.md).
Raw data: [`data/runs.jsonl`](data/runs.jsonl) (one row per report), [`data/analyzer.json`](data/analyzer.json) (one row per commit),
[`data/summary.json`](data/summary.json), [`data/cost-time.csv`](data/cost-time.csv). Harness: [`tools/impactbench-report-eval.mts`](../../tools/impactbench-report-eval.mts).

## Headline

1. **The analyzer is not the bottleneck; the report is.** The analyzer puts the truly affected code into evidence on 29 of 32
   commits (71 of 78 truth entities, 13 of 17 outside the diff), and every entity it finds reaches the LLM payload.
   The shipped report catches the bug in only **30% of reports (14 of 47)** and on **9 of 31 commits** by majority.
2. **Most misses are checks that test the right area with the wrong input.** The report points at the right capability, then
   tests the cases that still work (see "Why reports miss"). This is the highest-value fix.
3. **The lookup tool helps a little and costs about twice the time.** Catch 33% (lookup) vs 30% (base). Per commit: lookup better on
   5, worse on 2, tied on 18. On commits whose truth lies outside the diff: 4 of 8 vs 3 of 9. Forcing lookups (`lookup-always`) is
   worse (explained 24%). The model mostly re-reads functions already in the payload and almost never searches.
4. **Three cheap, certain fixes exist.** A payload budget (2 commits fail outright, payloads reach 4.8 MB), the `#` false positive in
   the validator (3 rejected reports, one of which had already caught the bug), and two analyzer extraction gaps.

Previous numbers (90 to 95% catch) came from excalidraw-11 and -15 only, which the prompt was tuned on. Across the corpus the shipped
report is far weaker. That gap is the main result of this run.

## What ran (and what changed from the plan)

| | Planned | Ran |
|---|---|---|
| Analyzer | 32 commits | 32 commits, `dev` HEAD, `--engine extended` |
| Reports | 3 variants x 3 runs x 32 = 288 | **108**, capped at $2 by the user |
| `base` | 96 | 47 (3 runs on 8 commits, 1 run on 23; excalidraw-21 not run) |
| `lookup` | 96 | 40 (3 runs on 8 commits, 1 run on 17; skipped above 1 MB payload) |
| `lookup-always` | 96 | 21 (3 runs on 7 commits, then dropped: most expensive, scored worst) |
| Cost | $10 to 15 | **$2.08** (reports $1.60, judge $0.48) |

Report model `openai/gpt-6-luna` (the configured model). Judge `deepseek/deepseek-v4-pro-0813`, which grades each check against the corpus
symptom and must say which check exposes the bug. Excalidraw used its generated application context (remapped to the commit's layout);
the 5 library repos had none.

Because most commits got 1 run, per-commit results below 3 runs are single samples. The 3-run comparisons are consola-01 to -03 and
excalidraw-01 to -05.

## 1. Analyzer

| | Result |
|---|---|
| Commits analyzed | 32 of 32, all `completed`, 1 to 13 s each |
| Truth entities in evidence | **71 of 78** (changed 55, blast radius 13, value receiver 3) |
| Truth outside the introducer diff | 13 of 17 |
| Truth in evidence but cut from the payload | 0 |
| Payload size | median 190 KB, max **4.8 MB**; 3 commits above 2 MB, 5 above 1 MB |

Misses (7 entities, 3 commits):

| Commit | Missed | In graph? | Likely cause |
|---|---|---|---|
| excalidraw-07 | `actionFinalize.perform` (fault), `restoreAppState` (consumer, outside diff) | yes | Action objects are dispatched by name through the action manager; no static edge from the change. |
| excalidraw-09 | `renderScene` (fault), `App.componentDidMount`, `excalidraw-app/index.tsx#<module>` | yes | The change wraps rendering in `throttleRAF`; callers reach it through a stored callback, not a call. |
| excalidraw-14 | `SendBackwardIcon`, `SendToBackIcon` (both faults) | **no** | Icons are `const X = createIcon(...)` values, not extracted as entities. |

Reports on these 3 commits: excalidraw-07 still caught (the changed code was enough), excalidraw-09 and -14 missed in every run.

## 2. QA report

### Rates per variant

| Variant | Reports | Valid | Caught | Explained | Commits caught (majority) | Lookups per report |
|---|---|---|---|---|---|---|
| base | 47 | 91% | **30%** | 30% | 9 of 31 | 0 |
| lookup | 40 | 95% | **33%** | 33% | 7 of 25 | 1.2 |
| lookup-always | 21 | 100% | 29% | 24% | 2 of 7 | 3.3 |

| Group (base / lookup) | base caught | lookup caught |
|---|---|---|
| Excalidraw (has application context) | 9 of 30 | 8 of 23 |
| Libraries (no context) | 5 of 17 | 5 of 17 |
| Truth outside the diff | 3 of 9 | 4 of 8 |
| Analyzer missed some truth | 1 of 3 | 1 of 3 |
| `same-signature-behavior` | 4 of 12 | 3 of 9 |
| `plain-logic` | 9 of 33 | 9 of 29 |

Application context did not raise the catch rate (excalidraw 30% vs libraries 29%). Context tells the report *where* to test;
it does not tell it *which input breaks*.

### Per commit

`c` changed entity, `b` blast radius, `r` value receiver, `m` missed by analyzer; `*` outside the introducer diff. Cells are caught/runs.

| Commit | Context | Payload KB | Truth | base | lookup | lookup-always |
|---|---|---|---|---|---|---|
| consola-01 | no | 30 | c c | 0/3 | 0/3 | 0/3 |
| consola-02 | no | 35 | c | 3/3 | 3/3 | 2/3 |
| consola-03 | no | 238 | c | 0/3 | 0/3 | 0/3 |
| excalidraw-01 | yes | 314 | c | 0/3 | 1/3 | 0/3 |
| excalidraw-02 | yes | 116 | c c | 2/3 | 1/3 | 3/3 |
| excalidraw-03 | yes | 177 | c b* b* b* | 1/3 | 1/3 | 1/3 |
| excalidraw-04 | yes | 214 | c | 0/3 | 0/3 | 0/3 |
| excalidraw-05 | yes | 468 | c | 1/3 | 1/2 | - |
| excalidraw-06 | yes | 132 | c c c c c | 0/1 | 0/1 | - |
| excalidraw-07 | yes | 13 | m c m* | 1/1 | 1/1 | - |
| excalidraw-08 | yes | 92 | c | 0/1 | 0/1 | - |
| excalidraw-09 | yes | 134 | c m* c m* m* | 0/1 | 0/1 | - |
| excalidraw-10 | yes | 563 | c c | 0/1 | 0/1 | - |
| excalidraw-11 (seen) | yes | 457 | c c r* | 1/1 | 1/1 | - |
| excalidraw-12 | yes | 878 | c b c | 0/1 | 1/1 | - |
| excalidraw-13 | yes | 2240 | c | 0/1 | - | - |
| excalidraw-14 | yes | 104 | m m r* r* | 0/1 | 0/1 | - |
| excalidraw-15 (seen) | yes | 329 | b c b b* b* b* b* b* | 0/1 rejected, draft caught | 1/1 | - |
| excalidraw-16 | yes | 202 | c c c | 1/1 | - | - |
| excalidraw-17 | yes | 1066 | c c | 1/1 | - | - |
| excalidraw-18 | yes | 107 | c | 1/1 (lenient, see caveats) | - | - |
| excalidraw-19 | yes | 3049 | c c c c | failed: over context window | - | - |
| excalidraw-20 | yes | 4856 | b* c b* | failed: over 8 MB input | - | - |
| excalidraw-21 | yes | 2007 | c c c | not run (budget) | - | - |
| json-server-01 | no | 4 | c | 1/1 | 0/1 | - |
| json-server-02 | no | 4 | c | 1/1 | 1/1 | - |
| ofetch-01 | no | 19 | c c | 0/1 | 0/1 | - |
| ofetch-02 | no | 28 | c c | 0/1 | 0/1 | - |
| pathe-01 | no | 23 | c c | 0/1 | 1/1 | - |
| ufo-01 | no | 248 | c c c | 0/1 | 0/1 rejected | - |
| ufo-02 | no | 227 | c c | 0/1 rejected | 0/1 rejected | - |
| ufo-03 | no | 57 | c | 0/1 | 0/1 | - |

Variance is large: json-server-01 caught with lookup and missed with base in the smoke test, then the reverse in the real run.

### Why reports miss

The analyzer had the faulty function in evidence for every miss below. The report named the right area each time. The judge's reason:

| Commit | What the report checked | What would have exposed the bug |
|---|---|---|
| consola-01 | Repeated logs followed by a different message | A burst of repeats with **no** following message |
| ofetch-02 | `application/json`, no type, text, XML, unknown types | A vendor type with a `+json` suffix, such as `application/vnd.api+json` |
| ufo-02 | Query values with strings and repeated keys | A query value of the number `0` |
| consola-03 | Prompt behaviour with typed options | An `initial` option on select and multiselect |

Pattern: the report lists the cases the **new** code handles, not the input the **old** code handled that the new code drops.
The diff usually shows it (a removed branch, a narrowed regex, a falsy check), but nothing asks the model to derive it.

### Validation failures (6 of 108 reports)

| Cause | Count | Commits | Note |
|---|---|---|---|
| `#` counted as Markdown | 3 | excalidraw-15, ufo-02 (2) | URL fragments (`/docs?x=1#top`) and HTML entities (`&#39;`) are rejected. The excalidraw-15 draft had **already caught the bug**. |
| Backticks around code | 1 | ufo-01 | A library check quoted `` `%20` ``; arguably correct to reject, but see roadmap item 7. |
| Payload over the model context | 1 | excalidraw-19 | 1.31M tokens against a 1.05M limit |
| Payload over the provider's 8 MB input | 1 | excalidraw-20 | 4.8 MB payload, sent twice by the correction retry |

## 3. The lookup tool

`packages/reporting/src/code-lookup.ts`: three modes (`entity` source with callers and callees, `file` outline, `search` text), at most
4 rounds and 12 lookups, 12 KB per result, reading the analyzed revision. Shipped behind `npm run report -- --lookup`.

| Finding | Number |
|---|---|
| Reports that used it when optional | 24 of 40 |
| Lookups that found code | 119 of 119 |
| Lookups by mode | `entity` 111, `search` 7, `file` 1 |
| Reports whose lookups reached a truth entity | 22 of 61 lookup reports |
| ... reached truth **outside** the diff | 1 (excalidraw-11) |
| Paired per commit, lookup vs base | better 5, worse 2, tied 18 |
| Time and cost vs base, same commit (median) | 1.9x time, 1.5x cost |

What it looked up (111 of 119 were `entity` reads): nearly always the changed function or a direct caller by its exact ID, already listed in the payload. It wanted
the *body* of code the payload names but does not show. Twice it searched for a CSS class or a constant name (excalidraw-03), which
is the use the tool was designed for. On excalidraw-07 it read `actionFinalize.keyTest`, next to the missed `actionFinalize.perform`,
but did not open that one.

Wins: excalidraw-12 (0/1 to 1/1), excalidraw-15 (rejected to caught), pathe-01 (0/1 to 1/1), excalidraw-01 and -05 (one more run each).
Losses: excalidraw-02 (2/3 to 1/3), json-server-01 (1/1 to 0/1).

Conclusion: the model's real need is **code bodies for the entities the payload already names**, not discovery. That points to
putting short bodies of the top-ranked entities into the payload (cheap, one call) rather than a tool loop. Keep `--lookup` as an
option, not the default.

## 4. Cost and time by payload size

From [`data/cost-time.csv`](data/cost-time.csv) (every report, with payload size, seconds, tokens and cost). Cost includes the judge.

| Variant | Payload KB | Reports | Mean seconds | Mean cost |
|---|---|---|---|---|
| base | 0 to 50 | 12 | 145 | $0.006 |
| base | 50 to 250 | 21 | 276 | $0.009 |
| base | 250 to 500 | 8 | 332 | $0.018 |
| base | 500 to 1024 | 2 | 645 | $0.075 |
| base | 1024 to 2048 | 1 | 585 | $0.103 |
| base | above 2048 | 3 | 290 (fails fast) | $0.082 |
| lookup | 0 to 50 | 12 | 297 | $0.007 |
| lookup | 50 to 250 | 19 | 514 | $0.017 |
| lookup | 250 to 500 | 7 | 545 | $0.029 |
| lookup | 500 to 1024 | 2 | 650 | $0.107 |
| lookup-always | 0 to 50 | 6 | 369 | $0.010 |
| lookup-always | 50 to 250 | 12 | 543 | $0.017 |
| lookup-always | 250 to 500 | 3 | 623 | $0.028 |

Cost is close to linear in payload size above about 250 KB, where prompt caching stops covering most of the input. Lookup roughly
doubles time at every size because each round resends the whole payload. A full 3-run corpus pass at current payload sizes costs
about $9; with a 250 KB payload budget it would cost about $2 to 3.

## 5. Roadmap, ranked

Each item names the evidence behind it and how to tell it worked. Re-run with
`node --import tsx tools/impactbench-report-eval.mts run ...` and compare against `data/summary.json`.

| # | Change | Why (evidence) | Expected effect | Effort |
|---|---|---|---|---|
| 1 | **Triggering-input step in the prompt.** Before writing checks, for each change list what input the old code handled that the new code treats differently (removed branch, narrowed condition, falsy check, changed regex, suffix or prefix rule), and require one check to use that exact input. | 4 of 4 sampled misses tested the right area with the wrong input (consola-01, ofetch-02, ufo-02, consola-03). | Largest gain available: most misses already have the right area. Target base catch rate from 30% to above 50%. | Small (prompt + payload hint) |
| 2 | **Payload budget with ranking.** Cap the payload (start at 250 KB): rank changes, keep top paths, drop duplicate `diff` next to `removedCode`/`addedCode`, cap blast-radius entities per change. Never send above the model context. | 2 hard failures (excalidraw-19, -20), 3 commits above 2 MB, cost linear in size. | Removes both failures; about 3 to 4x cheaper on large commits; faster. Must not drop truth: check `inPayload` stays 71 of 71. | Medium |
| 3 | **Fix the `#` false positive.** Allow `#` inside a word, URL or entity; reject only heading markers at the start of a field. | 3 rejected reports, one of which (excalidraw-15) had caught the bug. | About +3 valid reports per 100; removes the ufo-02 rejections. | Tiny |
| 4 | **Code bodies for top entities in the payload.** Add a short body (about 30 lines) for the changed entities and the top ranked receivers and callers. | Lookup usage: 111 of 119 lookups were `entity` reads, nearly all of an entity already named in the payload; lookup wins came from that. | Most of the lookup gain at one call's cost instead of about 2x. Pair with item 2 so the size stays capped. | Small |
| 5 | **Analyzer: extract `const X = factory(...)` values** (icons, styled components) as entities. | excalidraw-14: both faults are not in the graph. | Closes 2 of 7 missed truth entities. | Small to medium |
| 6 | **Analyzer: callback and dispatch edges.** Follow values stored and invoked later (throttled render callbacks, action objects dispatched by name) as `likely` edges. | excalidraw-07 (2 missed) and excalidraw-09 (3 missed). | Closes up to 5 of 7 missed truth entities. | Medium to large |
| 7 | **Library mode for the report.** For `platform: library` (or no context), allow literal API inputs in checks and speak to a developer, not a page tester. | Libraries catch as often as the app (29% vs 30%) without context; context did not change catch rate; library checks need literal inputs such as `0` or `.env`. | Fewer validator rejections; more precise inputs. | Small |
| 8 | **Make lookup targeted, or leave it off by default.** If kept: seed it with the receivers and outside-diff candidates, and allow one `search` round. Drop the "always look up" policy. | Lookup reached outside-diff truth once; `lookup-always` explained less (24% vs 30%). | Decide after items 1 and 4, which may remove most of its value. | Small |
| 9 | **Measurement.** 3 runs on every commit; a stricter judge rule ("a link check must verify the destination"); 10 hand-checked verdicts per run. | 1 of 4 spot checks was lenient (excalidraw-18); most commits had 1 run. | Trustworthy deltas between variants. About $3 per full pass after item 2. | Small |

Suggested order: 3 (minutes), 1 and 4 together, then 2, then re-run the corpus with 3 runs. Then the analyzer items 5 and 6.

## Caveats

- **Sample size.** 23 of 31 commits have 1 run per variant. Only the 3-run commits support a per-commit claim. Lookup's +3 points is
  within noise; the 5-better/2-worse split is suggestive, not proven.
- **Judge.** One judge model, one call per report. In a hand spot check of 4 verdicts, consola-01 and ofetch-02 were correct misses,
  excalidraw-18 was too lenient (the check opens the banner link but does not verify its destination), and pathe-01 is debatable
  (it uses a dotfile but expects `.env` as the extension). Catch rates may be slightly overstated.
- **Seen commits.** excalidraw-11 and -15 were tuned on before; both were caught with lookup and are marked "seen".
- **Context.** Excalidraw context was generated on today's layout and remapped by path; summaries can describe newer code.
- **Model.** One report model. The earlier excalidraw-11 numbers used `deepseek/deepseek-v4.1-flash-1017`, so they are not directly comparable.

## Reproduce

```sh
export NODE_USE_ENV_PROXY=1   # needed in the sandbox for Node to reach OpenRouter
node --import tsx tools/impactbench-report-eval.mts evidence --history <history-dir> --work <work-dir>
node --import tsx tools/impactbench-report-eval.mts run --history <history-dir> --work <work-dir> --variants base,lookup --runs 3 --lookup-max-kb 1024
node --import tsx tools/impactbench-report-eval.mts summary
```

`<history-dir>` holds a full-history clone per corpus repo (see `impactbench/corpus/README.md`). `.env` and the excalidraw context are
read from the main checkout when the worktree has none.
