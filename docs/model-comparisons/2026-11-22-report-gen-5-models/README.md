# Report-generation model comparison: DeepSeek V4.1 Flash, GPT-6 Luna, Claude Haiku, GLM-5.3 Flash, MiniMax M3.1 Flash

Run date: 2026-11-22. Both models ran in parallel (one stream each) through `tools/report.ts --generate-context`
against 5 real commits of https://github.com/unjs/ofetch (full SHAs in `commits.txt`). Provider: OpenRouter.

| Model slug | List price in/out per M tokens |
|---|---|
| `deepseek/deepseek-v4.1-flash-1017` | $0.15 / $0.60 (time-of-day surcharge possible) |
| `openai/gpt-6-luna` | $0.10 / $0.50 |

## Headline (5 commits, report-generation LLM call only)
| | DeepSeek | Luna | Luna advantage |
|---|---|---|---|
| Billed cost | $0.00741 | $0.00363 | 51% cheaper |
| Time | 44.9 s | 26.5 s | 41% faster |
| Output tokens | 8086 | 2036 | 75% fewer |

Per-commit numbers: `results.csv` / `results.json`. Cost = OpenRouter `usage.cost`. Time = `durationMs` of the `request.completed` trace event.
Quality is NOT scored here; it is judged manually by the user in Claude Code by reading the `report.md` files.

## Layout
- `runs/<commit>/<model>/report.md`: the generated QA report
- `runs/<commit>/<model>/trace.log`: raw LLM trace (usage, duration, finish reason)
- `runs/<commit>/<model>/evidence.json`, `application-context.json`: deterministic input and the model-generated context
- `run.sh`, `analyze.mjs`: scripts used (paths inside are from the original scratchpad; adapt)

## Caveats
- Application-context generation (an LLM call per run) is not in the trace, so its cost/time is excluded.
- Commits were chosen as ones the analyzer supports (many ofetch commits report "no supported function declarations"); 5 runs per model is a small sample.
- To re-run a new model on the same commits: clone ofetch, check out each SHA, run `OPENROUTER_MODEL=<slug> node --import tsx tools/report.ts --target <checkout> --base <sha>^ --head <sha> --generate-context --report out.md` (in sandbox: `NODE_USE_ENV_PROXY=1`; avoid the tsx CLI).

## Round 2: added `~anthropic/claude-haiku-latest` (resolved to anthropic/claude-haiku-5.5, $0.10/$0.50 per M)
Same 5 commits. Haiku FAILED tool validation on 3baf1cc after 2 attempts ("keyChanges must not include source file names or entity identifiers"), so it has 4 valid reports.
Cost/time on the 4 commits all three completed (Haiku's 6a879d4 run needed 1 retry, included):
| | DeepSeek | Luna | Haiku |
|---|---|---|---|
| valid reports | 5/5 | 5/5 | 4/5 |
| cost (4 commits) | $0.00668 | $0.00318 | $0.00445 |
| time (4 commits) | 37.6 s | 22.4 s | 23.3 s |

## Round 3: added `z-ai/glm-5.3-flash` and `minimax/minimax-m3.1-flash`
Same 5 commits, run in parallel. Raw per-run data for all 5 models: `results-all-models.csv`. GLM had 2 runs hit a network "Connection error" (infra, not model); those 2 commits were re-run once and succeeded. The 4 commits all models completed:
| | DeepSeek | Luna | Haiku | GLM-5.3 Flash | MiniMax M3.1 Flash |
|---|---|---|---|---|---|
| valid reports (of 5) | 5 | 5 | 4 | 5 | 5 |
| cost (4 commits) | $0.00668 | $0.00318 | $0.00445 | $0.00386 | $0.01134 |
| time (4 commits) | 37.6 s | 22.4 s | 23.3 s | 93.1 s | 72.6 s |
| output tokens (all valid runs) | 8086 | 2036 | 2824 | 11285 | 14761 |
MiniMax is the most expensive despite the cheapest list price ($0.075/$0.30) because it emits ~7x Luna's output tokens; GLM is cheapest per token but slowest.

## Quality judging
Judged in Claude Code by Claude Opus 5.5 reading every report against the real `src` diff (no OpenRouter or API judge). Reports were blinded: per commit, shuffled letters, mapping opened only after all scores were written. Per-report scores and notes: `quality-scores.csv`.
Each report scored 1-5 on accuracy (true to diff), completeness (covers all behavior changes), qa_value (specific, runnable checks on the changed behavior), clarity.

| Model | accuracy | completeness | qa_value | clarity | total /20 | bug-catching (completeness + qa) /10 |
|---|---|---|---|---|---|---|
| GLM-5.3 Flash | 4.8 | 4.2 | 4.4 | 3.2 | **16.6** | **8.6** |
| DeepSeek V4.1 Flash | 4.8 | 3.8 | 4.2 | 3.8 | **16.6** | 8.0 |
| Claude Haiku (4 commits) | 4.5 | 3.75 | 4.25 | 3.25 | 15.75 | 8.0 |
| MiniMax M3.1 Flash | 4.0 | 3.8 | 3.6 | 3.6 | 15.0 | 7.4 |
| GPT-6 Luna | 4.6 | 2.6 | 2.6 | 4.2 | 14.0 | 5.2 |

Notable findings:
- 571dcc9: MiniMax claimed event-stream types with parameters stay on text handling; false, since `split(";")` strips parameters first.
- 3baf1cc: Luna framed the change as new async hook support; awaiting already existed, the change is array support.
- 0d84f7b: Haiku and Luna missed the new fallback to a Request object's own headers.
- Shared misses (all models): the `.ts` import-extension change in 413397a, and on 6a879d4 the ufo-to-inline swap risk and the `startsWith` prefix edge case (base `/api` blocks `/apiv2`). These may come from what the analyzer evidence exposes, not only the models.

## Summary (same 4 commits all models completed)
| Model | Bug-catching /10 | Cost per 1k reports | Seconds per report | Failed runs |
|---|---|---|---|---|
| GLM-5.3 Flash | 8.5 | $0.97 | 23.3 | 0/5 |
| Claude Haiku | 8.0 (best case 8.2 had it not failed) | $1.11 | 5.8 | 1/5 |
| DeepSeek V4.1 Flash | 7.75 | $1.67 | 9.4 | 0/5 |
| MiniMax M3.1 Flash | 7.5 | $2.84 | 18.2 | 0/5 |
| GPT-6 Luna | 5.25 | $0.80 | 5.6 | 0/5 |
Cost per 1k is extrapolated from the 4-commit billed totals.

## Did the reports find the real risks?
Risks in the diffs, and whether any report flagged them:
| Commit | Risk | Flagged by |
|---|---|---|
| 3baf1cc | A throwing hook skips all later hooks in the array | GLM, DeepSeek |
| 0d84f7b | Header fallback to the Request object's own headers; array/object/Headers inputs | GLM (both); DeepSeek, Luna (fallback only) |
| 0d84f7b | query/params precedence | GLM partly (asked QA to confirm order) |
| 571dcc9 | Case-sensitive match: `TEXT/EVENT-STREAM` falls back to text | DeepSeek |
| 6a879d4 | `startsWith` prefix bug: base `/api` does not prefix `/apiv2` (real latent bug) | none |
| 6a879d4 | `ufo` swapped for hand-written URL code | none |
| 413397a | `.ts` import extensions can break builds | none |
The 3 universal misses may be analyzer evidence gaps (function-level only) rather than model gaps; worth checking what evidence was sent.
