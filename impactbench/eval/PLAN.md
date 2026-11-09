# Corpus-32 evaluation plan: analyzer + QA report + code lookup

Goal: run the shipped analyzer and the shipped QA report on all 32 D-0 corpus commits, add a `lookup` tool the report
LLM can call when its context is thin, and turn the results into a ranked list of what to build next.
The report (`REPORT.md`, same folder) is the deliverable: every recommendation in it must point at a number from this run.

Branch: `eval/corpus32-lookup-tool` (from `dev` at 983bc19).

## Questions this run must answer

| # | Question | Why it matters |
|---|---|---|
| Q1 | For each commit, does the analyzer put the truly affected entities into evidence (changed, blast radius, receivers)? | The report cannot test what evidence never mentions. Analyzer recall is the ceiling. |
| Q2 | Do those entities survive into the LLM payload (context-pack caps, ranking)? | A hit in evidence that is cut from the payload is still a miss. |
| Q3 | How often does the shipped report produce a valid report, a check that would expose the bug, and an explanation of the cause? | This is the product's headline number. Until now it was measured on 2 of 32 commits. |
| Q4 | Does a `lookup` tool (read the code of an entity, a file outline, or grep) raise catch or explain rates? On which commits? Does it cost validity? | Tests whether "let the LLM fetch more code" is worth building in. |
| Q5 | What does the LLM look up when allowed? | Its queries show what the payload is missing. That is a direct roadmap signal. |
| Q6 | Where do failures cluster (repo, change class, library vs app, context present or absent, truth outside the diff)? | Tells us which gap to fix first. |

## Corpus

`impactbench/corpus/d0-corpus.json`: 32 commits from 6 repos (excalidraw 21, consola 3, ufo 3, json-server 2, ofetch 2,
pathe 1). Each has the introducer SHA, symptom, user-visible areas and ground-truth affected entities; 17 of 77 truth
entities lie outside the introducer diff. Truth was written before any contender ran, and this run does not edit it.

## Conditions held fixed

- Analyzer: `dev` HEAD, `--engine extended`, `--base <sha>~1 --head <sha>`, in a clean checkout of the introducer.
- Application context: excalidraw uses the existing generated context (`fixtures/large-repos/excalidraw`), with file summaries
  remapped from today's layout to the commit's layout, as in the excalidraw-11 experiments. The other 5 repos have **no**
  generated context, so they get an empty v2 context. This is realistic for a first run on a new repo, and it is exactly the
  "context is not enough" case the lookup tool is meant for. The report states results separately for both groups.
- Report model: `openai/gpt-6-luna` (the configured `OPENROUTER_MODEL`). Judge: `deepseek/deepseek-v4-pro-0813`
  (a different model family, to avoid a model grading its own output).
- 3 runs per commit per variant (288 reports). Temperature is the provider default; variance is reported, not hidden.

## Variants

| Variant | What changes | Instruction |
|---|---|---|
| `base` | Shipped code. One structured call, no tools. | Shipped `qaInstruction`. |
| `lookup` | The LLM may call `lookup` before writing. It decides whether to. | Shipped instruction + one paragraph describing the tool as optional. |
| `lookup-always` | Same tool. The LLM is told to look up, before writing, every receiver, caller or entity whose behaviour it cannot judge from the payload. | Shipped instruction + a stronger paragraph. |

### The lookup tool

`packages/reporting/src/code-lookup.ts`. Read-only and bounded. Its source is the same revision the evidence describes.

| Mode | Input | Returns |
|---|---|---|
| `entity` | entity ID or name (exact, then case-insensitive, then substring) | kind, file, lines, source (capped at 120 lines), callers and callees from the graph |
| `file` | repository-relative path | entities in the file with line ranges, and the first 80 lines |
| `search` | plain text | up to 20 matches `file:line` with the enclosing entity, across analyzed files |

- At most 4 tool rounds, and 12 lookups per report. Each result is capped at 12 KB. Every lookup is logged with its query,
  mode, hit or miss, and the entity IDs it returned.
- Results are data, never instructions, and they cannot override the graph (the tool reads the graph; it does not add edges).
- Flow: an investigation phase with `tools` and no response format, then one final structured call where the lookups are
  passed back as a data message. This keeps one code path for providers that refuse tools together with a JSON schema.
  The existing semantic validation and the one correction retry are unchanged.
- Wired into `generateQAReport(..., { lookup })` and `npm run report -- --lookup` so it can ship if the numbers justify it.

## Scoring

Per commit (deterministic, no LLM):
- `inEvidence`: truth entities found as changed entity, blast radius, or value receiver. Split by `outsideIntroducerDiff`.
- `inPayload`: truth entities that are still present in the payload sent to the LLM.
- Payload size, impact count, analyzer time.

Per report (judge, one call per report, the truth goes to the judge and never to the report model):
- `valid`: a report passed schema and semantic validation (else the error kind: no content, invalid JSON, identifier leak, other).
- `catch`: at least one check would show the symptom if a tester did it on the introducer build. The judge rates **each
  check** against the symptom and affected areas and must quote the check, so a vague "verify it still works" does not count.
- `explained`: some field names the mechanism (what changed and why it breaks the symptom area).
- `area`: the report points the tester at one of the corpus `areas`.
- Lookup runs: number of lookups, whether any lookup returned a truth entity, and whether it returned one outside the diff.

Headline numbers are rates over all 96 reports per variant, with a per-commit majority (2 of 3 runs) next to each one.
A difference between variants counts as real only if it holds on the per-commit majority, not on a single run.

## Honesty rules

- Truth, rubric and judge prompt are fixed before the first report runs. No re-grading after seeing scores, except to fix a
  judge crash, and any re-grade is logged.
- Two judge verdicts per variant are spot-checked by hand for each repo, and disagreements are written in the report.
- Excalidraw-11 and excalidraw-15 were tuned on before. They are reported but flagged as seen.
- Cost and failures are reported in full, including empty reports and validation rejections.

## Steps

1. Build the lookup tool and its tests; wire it into the report generator and CLI. (`npm test` for reporting stays green.)
2. Generate fresh evidence for all 32 commits with `dev` HEAD (`tools/impactbench-report-eval.mts evidence`).
3. Run `base`, `lookup` and `lookup-always`, 3 runs each, and judge every report (`... run`).
4. Aggregate (`... summary`) into `impactbench/eval/data/summary.json`. Raw rows go to `data/runs.jsonl`.
5. Write `REPORT.md`: headline, per-commit table, failure taxonomy, what the LLM looked up, and a ranked roadmap with
   expected effect and the commit numbers behind each item.

## Out of scope for this run

- Changing the analyzer or the prompt to fix a gap. This run measures; fixes come after, against these numbers.
- Generating application context for the 5 library repos (listed as a roadmap item with its expected effect instead).
