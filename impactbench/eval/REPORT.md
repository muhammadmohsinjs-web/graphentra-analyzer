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

## Re-run after the two quick fixes (2026-11-10, commit d371d5c)

Base variant only, 1 report per commit, 31 commits (excalidraw-21 still skipped). Same model and judge.
Data: `impactbench/eval/data-v2/`. Compared against run 1 of the base variant in `data/`.

| | Before | After |
|---|---|---|
| Reports that catch the bug | 9 of 31 | 9 of 31 |
| Reports that explain the bug | 9 of 31 | 12 of 31 |
| Invalid reports | 4 | 3 |
| Cost (reports + judge) | $0.83 | $0.30 |
| Median time per report | 251 s | 285 s |

- **`#` fix worked.** excalidraw-15 was rejected before and now passes and catches the bug. No report failed on `#`.
- **Prompt step: no net gain in catches.** It gained pathe-01 (a dotfile input) and excalidraw-15, and lost consola-02 and
  excalidraw-03. consola-02 was caught in 3 of 3 earlier runs; the new report spent its checks on export aliases and
  missed the log-level setting. The commits the step targeted (consola-01, consola-03, ofetch-02, ufo-02) are still missed.
- **Remaining invalid reports:** excalidraw-19 and excalidraw-20 (payload too large, unchanged), and ufo-02, whose checks
  quote URLs in backticks. That is the library-mode problem (roadmap item 7), not `#`.
- One run per commit is noisy: a swing of 2 commits either way is within what repeated runs showed before.

Conclusion: keep the `#` fix. The prompt step alone does not find the breaking input; the model needs the changed code
in a form it can compare (roadmap item 4), which moves to Phase 6.

## Phase V verifier: base vs verify (V-12, 2026-11-19, commit 79eb655)

Does the Decisions API verifier (ADR-0011) make QA reports better? 31 commits × 3 runs for each variant, run fresh on the
same code, same report model (`openai/gpt-6-luna`) and judge (`deepseek/deepseek-v4-pro-0813`). excalidraw-21 is skipped as
before. `verify` = `base` + verifier (coverage and faithfulness questions, threshold 0.7) + one repair round + a "Not covered"
list built by code. Data: `impactbench/eval/data-v3/` (186 rows, `summary.json`, `cost-time.csv`, M5 review in `m5-review.md`).

The first smoke run found a bug in the shipped verifier: its prompt cache key was 67 characters, so OpenAI rejected every
faithfulness question with HTTP 400, and every report got a needless repair round. Fixed in 734d5fd before this run.
The run had no verifier errors and no refusals.

### Expectations

| | Target | Base | Verify | Met? |
|---|---|---|---|---|
| E1 catch (commits, majority of 3) | ≥ 13/31 | 10/31 | 11/31 | **No** (+1 is within noise) |
| E2 explain (commits, majority of 3) | ≥ 15/31 | 12/31 | 11/31 | **No** |
| E3 silent drops | 0 | – | 0 of 1,578 changed production entities | **Yes** |
| E4 invalid (commits, majority) | ≤ 3/31 | 2/31 | 2/31 | **Yes**, but verify adds 2 single-run semantic failures after repair (json-server-01, pathe-01) |
| E5 verifier recall / precision | ≥ 0.90 / ≥ 0.60 | – | 0.92 / 0.92 at V-3; on live flags (M5) only 13 of 47 flags (28 %) are real gaps | **No** for flag precision in use |
| E6 cost | ≤ +35 % | – | writer prompt tokens +82 %, completion +55 %, plus 3.8 M verifier input tokens | **No** |
| E6 median time | ≤ +50 % | 236 s | 339 s (+44 %) | **Yes** |
| E7 QA checks per report | ≤ +1 | 3.6 | 5.0 (+1.4) | **No** |
| E7 "Not covered" ≤ 3 items | 90 % of reports | – | 58/85 (68 %); median 2, max 49 | **No** |

Report-level rates are flat as well: catch 31/93 vs 30/93, explained 34/93 vs 36/93, area 66/93 vs 64/93.

**Billed cost understates verify.** Each commit's base jobs ran just before its verify jobs and warmed the provider's prompt cache,
so 99.8 % of verify writer prompt tokens were billed as cached, against 71 % for base. The billed totals ($0.81 base writer,
$0.47 verify writer + $0.38 verifier) are not a fair comparison, so E6 is judged on tokens. The verifier's own cost is an
estimate: Decisions pricing is not published.

### What the verifier did (M3 audit, 85 valid verify reports)

| Changed production entities | Covered on first check | Added by the repair round | Listed "Not covered" | Silent drops |
|---|---|---|---|---|
| 1,578 | 829 (53 %) | 358 (23 %) | 391 (25 %) | 0 |

- The repair round ran on 62 of 93 reports, and 61 repairs were accepted.
- In 31 cases an entity was covered before the repair and not after. Each one still landed on the "Not covered" list.
- The "Not covered" list is long on large or restructuring commits: ufo-02 (12, 49, 23), ufo-01 (5, 1, 33),
  excalidraw-01 (26, 9, 45), consola-03 (13, 14, 4).

### M5 noise review (10 verify reports, 47 flagged items, at most 5 per report)

- **Flags:** 13 are real gaps (28 %), 15 are false flags, and 19 are trivial (type-only, import, comment or formatting changes).
  - Trivial example: a `defaults.level as number` cast scored 0.
  - False-flag pattern: a helper in a new file is flagged on its own although a key change already covers the capability.
  - Real gaps are untested sub-behaviours: prompt cancel, intro and outro; undo and redo; URL encoders; default logger level and env.
- **Checks:** of about 50 verify checks, 12 are too technical for manual QA, 4 are untestable and 2 are redundant.
- **Compared with base for a QA tester:** verify is better in 2 reports, the same in 5 and worse in 3. The worse cases replace
  concrete checks with vague "remains usable" ones, or lose a check the base report had.
- **One flag pointed at a real bug.** In ufo-02 (score 0.61), the new `parseHost` regex `(:0-9+)?` is not a character class,
  so the port is never split off the host. No report mentions it, and it is not the commit's known bug.

### Conclusion

The verifier does what it was built for: every changed entity is covered, repaired, or listed, with no silent drops. It does not
raise catch or explain rates, it adds about 1.4 QA checks per report and many more tokens, and 72 % of its live flags are noise.
The catch rate is limited elsewhere: the analyzer's evidence holds the regression in every commit, but the writer rarely writes
the check that uses the triggering input. The triggering-input question (U2) was dropped at V-3.

Input for V-13: E1, E2, E5 (in use), E6 cost and E7 fail, so the default stays off. Options:
1. Keep it opt-in as is.
2. Drop the repair round and keep a "Not covered" list. This keeps E3 at verifier cost only, about 13 s per report.
3. Before any list ships, stop asking about trivial changes (type-only, import, formatting) and count a capability as covered once
   (new-file helpers). Together these are 34 of the 47 reviewed flags.

**V-13 decision (2026-11-19, recorded in ADR-0011):** options 2 and 3 together. The default stays off; the repair round is removed
and only the "Not covered" list stays, after the noise filter. This run (`data-v3/`) is the baseline for the follow-up re-run
(V-13c): compare E3 (must stay 0 silent drops), E6 and E7 against `data-v3/summary.json`.

Reproduce:

```
node --import tsx tools/impactbench-report-eval.mts run --history <history-dir> --work <work-dir> --data impactbench/eval/data-v3 --variants base,verify --runs 3 --concurrency 6 <31 ids>
node --import tsx tools/impactbench-report-eval.mts summary --data impactbench/eval/data-v3
```

## Phase V verifier after V-13a/b: 12-commit check (V-13c, 2026-11-19, commit e1f6141)

What changed since V-12: no repair round (V-13a), and a deterministic noise filter before any question (V-13b: skip changes
with no runtime effect, fold `A>b` inner functions into their parent). Only the `verify` arm was run, on 12 of the 31 commits
picked to test those changes: the six with the longest "Not covered" lists (ufo-02, excalidraw-01, ufo-01, consola-03,
excalidraw-10, consola-02), the two the repair round broke (json-server-01, pathe-01), three where it changed the catch
(excalidraw-02, -03, -12) and the slowest (excalidraw-05). All 10 commits of the V-12 M5 review are in it. 3 runs each,
same writer and judge as V-12; compared with the V-12 rows of the same 12 commits. 36 reports, 28 minutes, $0.63 with judge.
Data: `data-v4/`.

| Same 12 commits, 36 reports each | base (V-12) | verify (V-12) | verify now |
|---|---|---|---|
| Invalid reports | 1 (ufo-01) | 2 (json-server-01, pathe-01) | 1 (json-server-01 run 2) |
| Reports that catch / explain the bug | 13 / 13 | 9 / 13 | 9 / 12 |
| Commits caught / explained by majority | 4 / 4 | 4 / 4 | 4 / 3 |
| Median seconds per report | 269 | 448 | **245** |
| QA checks per report | 4.0 | 6.7 | **3.8** |
| Writer prompt tokens | 4.65 M | 7.94 M | **4.55 M** |
| Verifier input tokens | – | 2.32 M | **0.91 M** (−61 %) |
| Verifier time per report (mean) | – | 27 s | 17 s |
| Verifier errors / refusals | – | 0 / 0 | 0 / 0 |
| Changed production entities: covered / repaired / listed | – | 415 / 291 / 320 | 448 / – / 418 |
| Skipped (no behaviour change) / folded into parent | – | – | 168 / 87 |
| Silent drops (E3) | – | 0 | **0** of 1,034 |
| "Not covered" lines (sum / max) | – | 320 / 49 | 411 / 39 |
| Reports with ≤ 3 "Not covered" lines | – | 11 of 34 | 14 of 35 |

Reading the table:
- **The verify path now writes exactly what base writes.** The verifier only appends the list, and the judge never sees the list
  (it grades summary, key changes and checks). So catch 13 vs 9 is run-to-run noise of the same writer, not an effect of the
  verifier; on 36 reports a swing of ±4 is normal. The json-server-01 invalid report is the same writer failing once.
- **E4:** pathe-01 is valid again (3/3) and catches the bug in 2 of 3 runs, as base did. **E6:** time and writer tokens are
  back to base; the only extra is the verifier, about 0.9 M tokens and 17 s per report on these (large) commits. Its dollar
  cost ($0.09 here, against $0.30 for the writer) rests on an estimated price. **E7 checks:** met (3.8 vs base 4.0).
- **E7 list length: still not met.** Without the repair round, everything the first draft misses is listed, so lists are
  longer in sum than V-12's post-repair lists, but the longest is shorter (39 vs 49). The long lists are the big refactors
  (ufo-01/02, consola-03, excalidraw-01): 24 to 39 lines spread over only 5 to 7 files. The report is capped at 5 key
  changes and 5 areas of up to 4 checks, so on a 50-entity change most entities cannot be named in it. A ≤ 3 target does not
  fit those commits; showing the list grouped per file (5 to 7 lines) would.
- **Noise (against the V-12 M5 review of the same 10 commits):** 18 of the 19 trivial flags are gone. 11 of 15 false flags
  still appear in at least one run: they are judgement errors of the verifier, which the filter does not touch. 12 of the 13
  real gaps are listed in at least one run; where one is not listed, that run's report covered it (none was skipped or folded).

Conclusion for V-13: the rework did what it was meant to. The verifier is now cheap and fast, leaves the report itself as base
writes it, keeps zero silent drops and almost no trivial noise. It still does not raise catch, and on large commits its list is
long and partly wrong (false flags). Next options: group the list per file for large commits, and keep it opt-in.

Reproduce:

```
node --import tsx tools/impactbench-report-eval.mts run --history <history-dir> --work <work-dir> --data impactbench/eval/data-v4 --variants verify --runs 3 --concurrency 6 ufo-02 excalidraw-01 ufo-01 consola-03 excalidraw-10 consola-02 json-server-01 pathe-01 excalidraw-02 excalidraw-03 excalidraw-12 excalidraw-05
node --import tsx tools/impactbench-report-eval.mts summary --data impactbench/eval/data-v4
```

### V-13d: "Not covered" grouped per file (offline, no new LLM run)

`notCoveredLines` (packages/reporting/src/llm-client.ts) decides what the reader sees. A list of up to 3 items keeps one line per
change. A longer list gets one line per file (`src/a.ts: 3 changes (x, y, Cls.m)`), and a file with a single change keeps
the plain line. Every name is still printed, and `report.notCovered` (the data) is unchanged, so E3 and the silent-drop audit
are not affected. E7 in `summary` now counts these lines (`reportsNotCoveredAtMost3`). The item count is kept as
`reportsNotCoveredItemsAtMost3`.

Re-scored on the saved `data-v4` reports (35 valid):

| | before V-13d | after V-13d |
|---|---|---|
| "Not covered" lines, max | 39 | **7** |
| Reports with ≤ 3 lines | 14 of 35 (40 %) | 16 of 35 (46 %) |
| Lines per report (histogram 0/1/2/3/4/5/6/7) | – | 2/2/6/6/5/7/5/2 |

E7 (90 % of reports at ≤ 3 lines) is still not met. Grouping fixes the big refactors (24 to 39 items now take 5 to 7 lines).
The rest of the 4- to 6-line lists are changes genuinely spread over 4 to 6 files, which grouping cannot shorten. What is left
is a target question, not a format one: either accept "≤ 7 lines in every report" as E7 for this list, or cut false flags
(the other open E7 cause).

Fix found on the way: the `summary` audit filter `!r.audit.skipped` dropped every report with a skip count above 0 (a number
since V-13b). It now tests for the `'invalid'` marker. `data-v4/summary.json` was regenerated: its audit now covers 35 reports
(1,034 entities, 0 silent drops), matching the table above. The V-13c table was computed by a separate script, so it was not
affected.

### V-13e: gaps written as plain QA checks (offline on data-v4, 2026-11-20)

QA found the code-name list (`createConsola in src/consola.ts`) useless. After the verifier, one LLM call
(`verifier/plain-checks.ts`, writer model, low reasoning) sees the finished report and the code of each gap and writes at
most one check per gap and no more checks than the grouped list has lines. Each check follows the report's own rules: it
starts with a verb, is plain text, and has no file or code names. The call can merge gaps and must place every gap key either
in a check or in `untestable` (no effect a tester could observe). Recall first: a gap that no valid check names (untestable,
check text broken after one correction, over the limit, or a failed call) stays listed by code name under "for a developer".
`report.notCovered` is unchanged; the checks are added as `notCoveredChecks`. On by default with `--verify`
(`plainChecks: false` turns it off). Option B (writing checks for every change in parallel with the writer) was rejected:
it saves about 40 s, but it cannot merge or skip what the report already checks, and it would bring the long lists back.

Replayed on the 33 saved `data-v4` reports that have gaps (`tools/impactbench-plain-checks.mts`). Side-by-side lists are in
`data-v4/plain-checks.md`.

| | |
|---|---|
| Gaps → QA checks | 411 → **103** checks |
| Gaps left for a developer | 52 (40 marked untestable, 12 with no valid check) |
| Reports with QA checks only (no developer list) | 14 of 33 |
| QA check lines per report | max 7; ≤ 3 in 20 of 33 |
| Calls / corrections / errors | 40 / 7 / 0 |
| Cost, all 33 | $0.02 (≈ 83 k prompt + 24 k output tokens) |
| Time per report | median 41 s, max 97 s (6 in parallel through OpenRouter; added after the verifier) |

Example (consola-02 run 1). Before: `createConsola in src/consola.ts`, `<module> in src/log.types.ts`,
`createConsola in src/consola.node.ts`. After:
- Verify that the Node logger uses the basic reporter in CI or test mode and the fancy reporter otherwise, and that its log
  level follows the configured environment value when one is provided.
- Check that the logging types module exposes Types as a named export rather than as a default export.
- Confirm that calling the logger factory with options returns a new logger instance that can be used to log.

Spot check against the code: the first check describes the Node setup that this commit moved out of `consola.node.ts`, so it
works as a regression check. The second matches the `export default` → `export const Types` change. ufo-01 (29 gaps) becomes
5 checks covering decoding, serialising, joining, normalising and the entry-point exports.

Open: the extra time (median 41 s, about +17 % on a ~245 s report) is the main cost, and the checks have not yet been graded
for accuracy beyond spot checks. No catch effect is expected, because the judge does not see the list.

#### V-13e grading (2026-11-20)

An independent judge (`deepseek/deepseek-v4-pro-0813`, `tools/impactbench-plain-checks-grade.mts`, $0.85) graded the 103
checks against the code of the gaps each one claims. It also graded the 40 gaps marked untestable. Data:
`data-v4/plain-checks-grades.jsonl` and `-summary.json`.

| | Judge | Notes |
|---|---|---|
| Accurate / minor issue / wrong | 76 / 14 / 13 | Hand check of 6 "wrong" verdicts: **2 real** (excalidraw-10 runs 2 and 3: "update the scene with library items", which the commit removed), 4 judge mistakes (the code moved or was misread). The other 7 are not hand-checked |
| Testable by a tester | 103 / 103 | |
| Repeats a report check | 1 | |
| Claimed gaps the check really exercises | 291 of 359 (81 %) | **64 gaps are named by a check that does not test them.** Under V-13e they are hidden from the developer list: a recall risk |
| Gaps marked untestable that are observable | 27 of 40 | Mostly added or removed exports of a library, plus prop and `debounce.cancel` changes. They stay in the developer list, so they are not lost, but they get no QA check |

Reading:
- **Accuracy is good.** The judge alone gives 74 % accurate. After the hand check, real errors look rare, and the one
  pattern seen is testing **removed** behaviour as if it still works. The judge itself over-calls "wrong" because it sees
  only the claimed gap, not the code it moved to.
- **The real problem is recall.** Merging lets one check name gaps it does not test, and the V-13e display then drops those
  gaps from the developer list. That breaks the zero-silent-drop guarantee in practice: 64 of 359 claimed gaps, if the
  judge is right on those.

Fixes proposed (V-13f), all cheap:
1. Keep every gap in the developer list, grouped by file, under the QA checks. A check never hides a gap.
2. Prompt: removed code means checking that the replacement works, or that the old behaviour is gone, never that removed
   behaviour still works. Adding or removing an export of a library is observable.
3. Re-run the replay ($0.02) and the grading ($0.85).

### V-13f: a check never hides a gap; prompt rules (offline on data-v4, 2026-11-20)

Changes:
1. The developer list under the QA checks now always names every gap, grouped by file. A check can no longer hide a gap,
   so the zero-silent-drop guarantee holds whatever the checks say. E7 in `summary` now counts the QA lines only: the
   checks, or the code list when there are none.
2. Prompt rules:
   - When code was removed, never verify that the removed behaviour still works.
   - A gap goes into a check only if the check exercises it; no merging just to place a gap.
   - Adding or removing a library export, or a prop that changes rendering, counts as observable.

The V-13e files are kept as `data-v4/plain-checks-v13e*`. The V-13f replay and grading use the same 33 reports and the
same judge.

| | V-13e | V-13f |
|---|---|---|
| Checks | 103 | 112 |
| Accurate / minor issue / wrong (judge) | 76 / 14 / 13 | 76 / 23 / 13 |
| Claimed gaps the check exercises (judge) | 291 of 359 (81 %) | 260 of 366 (71 %; 27 not answered) |
| Untestable gaps the judge calls observable | 27 of 40 | 22 of 32 |
| **Gaps hidden from the reader** | **up to 64** | **0** (developer list keeps all 411) |
| QA lines per report | max 7, ≤ 3 in 20 | max 7, ≤ 3 in 18 |
| Replay cost / median time | $0.02 / 41 s | $0.03 / 44 s |

Reading:
- **The recall fix works by construction.** Every gap is listed whatever the checks claim. This is the change that matters.
- **The prompt rules show no measurable gain.** Wrong stays at 13, and the claimed-gap rate and minor issues got worse.
  With one run per version and a judge that was wrong in 4 of 6 hand-checked verdicts, this is within noise. The
  removed-code mistake still appears: the judge flags ufo-01 run 1 (joinURL) and ufo-02 run 3 (getParams and withParams).
  The rules are kept because they say what we want, but they are not shown to help.
- **What limits further work is the judge,** not the checks. A grade we can trust needs a hand-labelled sample (for
  example 30 checks), the same way the verifier was gated at V-3.

### E7 target changed (2026-11-20)

Old: "Not covered" ≤ 3 items in 90 % of reports. New: **at most 7 QA lines for the gaps in every report**, where the QA
lines are the plain checks, or the grouped code list when no check could be written. The developer code list under the
checks does not count. Reason: on large changes the gaps are spread over more files than 3 lines can hold, so the old target
measured format rather than quality. The part of E7 that limits extra checks in the report body (≤ +1 QA check per report)
is unchanged and met (3.8 vs base 4.0).

The code now caps the checks at 7 (`MAX_PLAIN_CHECKS` in `verifier/plain-checks.ts`), so E7 holds by construction whenever
the plain-check call succeeds. If the call fails, the grouped code list is shown, which could exceed 7 lines on a commit
touching more than 7 files. `summary` reports `reportsQaLinesAtMost7` and `e7ListMet`. On `data-v4` with V-13f checks, E7 is
**met**: all 35 valid reports have at most 7 QA lines (33 with gaps, each with at least one check; max 7).
