# Analyzer performance baseline (P4-4)

Measured with `npm run bench:perf` (`tools/bench-perf.mjs`). The bench runs the analyzer CLI
(`node --import tsx packages/analyzer/src/cli.ts --target <dir> --working-tree`, default
`--engine extended`) N times per target in a fresh child process, and records wall time and
peak RSS (`process.resourceUsage().maxRSS` inside the child). With `--profile` it re-runs the
largest synthetic repo under `node --cpu-prof` and aggregates self time per function and module.

## Machine

- Apple M4, 10 cores, 24 GiB, macOS (Darwin 25.6.0), Node v26.5.0, TypeScript from `node_modules`.
- Caveat: the machine was heavily shared during the run (load average 25-37 on 10 cores, other
  agents building in parallel). Wall times are pessimistic and noisy; min is the best proxy for
  an idle machine. The same 20-file fixture ranged 0.9 s to 11.8 s across sessions.

## Results (3 runs per target, one changed file, working-tree comparison)

| target | files | LOC | min s | median s | p95 s | peak RSS MB |
|---|---|---|---|---|---|---|
| fixtures/modern-app | 20 | 427 | 1.3 | 1.5 | 2.0 | 347 |
| synthetic-1000 | 1000 | 41,003 | 20.8 | 29.6 | 36.6 | 586 |
| synthetic-2000 | 2000 | 82,003 | 31.0 | 33.7 | 66.5 | 832 |
| synthetic-5000 | 5000 | 205,003 | 87.8 | 94.9 | 101.0 | 1499 |

- ImpactBench apps: skipped, `impactbench/work/` is not fetched in this checkout (the bench
  skips them gracefully; run `tools/impactbench.mjs fetch` first to include them).
- With only 3 runs, "p95" is effectively the slowest run. Use `--runs 5` or more for a firmer p95.
- Synthetic repo: N files of ~40 LOC (class, interface, helper functions), imports fan in on
  50 hub modules. A first version with a long import/type chain crashed the analyzer with
  `RangeError: Maximum call stack size exceeded` at 2000 files (see Open issues).
- Scaling is roughly linear in files from 2k to 5k (about 0.4 s per 1k LOC under load), with
  RSS growing about 0.28 MB per file.

## Top 3 costs (CPU profile, 5k files / 205k LOC, 68.4 s total self time)

1. **Synchronous git subprocesses: 51.7 s, 75.6 %** (`spawnSync` under `execFileSync`, called
   from `executeGit` in `packages/analyzer/src/repository.ts:89-93`). The likely driver is the
   per-file `git show <base>:<path>` at `repository.ts:322`, i.e. one process spawn per analyzed
   file (about 5,000 spawns), plus `ls-files` / `check-attr`. Self time of `spawnSync` is the
   wait on the child, so this is process-spawn latency, not analyzer computation. (Call-site
   attribution is inferred from the source, not from a call-stack aggregation.)
2. **AST normalization: 6.2 s, 9.1 %** (`serialize`, `get`, `leafText`, `operatorExtras` in
   `packages/analyzer/src/ast-normalize.ts`), used to hash/compare entity bodies.
3. **TypeScript parsing: 3.7 s, 5.3 %** (`typescript.js`, mostly `visitNode`/`visitNodes`).
   Next after that: evidence validation 1.6 s (2.3 %, `validator.ts`), GC 0.8 s.

Hypothesis refuted: `ts.createProgram` / type checking is not a top cost. The extended engine
parses and walks ASTs; type-checker functions do not appear in the top 15 by self time.

## Exit gate: p95 < 90 s on ~200k LOC

- Not met on this (loaded) machine: median 94.9 s, p95 101.0 s, min 87.8 s at 205k LOC.
- The overrun is almost entirely git process spawning (three quarters of the time), so it is
  cheap to fix and the number is dominated by an environment-sensitive cost. Documented
  measurement and plan: this file plus the recommendations below.
- Peak RSS 1.5 GB at 200k LOC is acceptable for CI runners but worth watching (grows with files).

## Recommendations

- **P4-5 (cache): cut.** Parsing plus normalization together are about 10 s at 200k LOC
  (under 20 s threshold), so a persistent cache would save less than the effort and adds
  invalidation risk.
- **P4-9 (parallelism): defer.** Only about 15 % of time is in-process CPU, so worker threads
  would help little. Do first: replace per-file `git show` with one `git cat-file --batch`
  stream (or a single `git archive`/`ls-tree` + batch read) for the base revision. Expected
  gain: removes most of the ~52 s, bringing 200k LOC to roughly 20-30 s on this machine.
  Re-measure with `npm run bench:perf`; reconsider P4-9 only if CPU time then dominates.

## Open issues found

- `RangeError: Maximum call stack size exceeded` (reported by the CLI only as
  `OPERATION_FAILED`, with the cause swallowed) on a 2000-file synthetic repo whose files form a
  long import/type chain. Likely deep recursion in the TypeScript checker or analyzer. Real
  repos with long dependency chains may hit it; worth a separate ticket. Not investigated further.
- `/usr/bin/time -l` cannot be used for RSS in sandboxed shells (sysctl denied), hence the
  in-child `maxRSS` approach.

## Reproduce

```
npm run bench:perf                                   # 5 runs, sizes 1000,5000, with profile
node tools/bench-perf.mjs --runs 5 --sizes 1000,2000,5000 --profile
node tools/bench-perf.mjs --skip-impactbench --keep  # keep the generated repos in the OS temp dir
```

## After batching (P4-4 follow-up)

Base-revision reads now go through `RepositoryContext.prefetchBaseline`, called once by
`createBaselineSnapshot`: `git cat-file --batch-check` for sizes (oversize blobs are never read),
then `git cat-file --batch` for in-limit blobs (chunked at 2,000 paths / 256 MB). Results are
cached per base SHA; missing, oversize and unusual paths still use the per-file `git show` path,
so bytes and `BaselineSourceError`s are unchanged. Git spawns for base reads: O(files) -> 2 per chunk.

Command: `node tools/bench-perf.mjs --runs 3 --sizes 2000,5000 --skip-impactbench`
(same machine; the "before" run was on a loaded machine, so it is noisy).

| target | before median s (this session) | before (profile run) | after median s | after p95 s |
|---|---|---|---|---|
| synthetic-2000 (82k LOC) | 63.5 | 33.7 | 7.4 | 9.0 |
| synthetic-5000 (205k LOC) | 70.5 | 94.9 | 20.2 | 20.4 |

Peak RSS is unchanged (about 0.85 GB and 1.5 GB). The 90 s p95 gate is met with wide margin at 200k LOC.

## Phase R baseline (R-0, 2026-11-24)

What the report model gets, and how report quality falls as a change grows. Every later Phase R step
(R-2, R-10, R-3, R-8) is compared against these tables. Data: corpus-31 (`d0-corpus.json` without
excalidraw-21), Phase V `verify` variant, 3 runs per commit, graded by hand in blind sets A/B
(`impactbench/eval/data-v6-glm/hand-grades-glm-vs-luna.jsonl`). Both models ran on the same evidence
(identical changed-function counts and payload bytes in `analyzer.json`).

### Results by change size

*Caught* counts commits where at least one of 3 runs caught the regression; *majority* counts commits where 2 or more did.
*Coverage* is the share of changed production functions that the report covered (Phase V audit, `audit.covered / audit.production`).
*Out tok* is the writer's mean completion tokens per report (reasoning included). Costs are the writer plus the verifier; no API judge.

**Default report model, `openai/gpt-6-luna`** (`impactbench/eval/data-v5`)

| Changed functions | Commits | Caught | Majority | Explained | Valid | Coverage | Out tok | Checks | Mean $ | Mean s |
|---|---|---|---|---|---|---|---|---|---|---|
| ≤ 10 | 12 | 4 | 4 | 5 | 35/36 | 65% | 1,801 | 2.4 | 0.0089 | 306 |
| 11–25 | 10 | 3 | 3 | 4 | 30/30 | 62% | 2,834 | 4.3 | 0.0191 | 276 |
| > 25 | 9 | **0** | 0 | 1 | 21/27 | 43% | 2,394 | 3.5 | 0.0229 | 202 |

| Payload (as sent) | Commits | Caught | Valid | Coverage | Mean $ | Mean s |
|---|---|---|---|---|---|---|
| < 50 KB | 8 | 3 | 23/24 | 65% | 0.0043 | 257 |
| 50–250 KB | 13 | 2 | 39/39 | 45% | 0.0119 | 265 |
| 250–500 KB | 4 | 2 | 12/12 | 41% | 0.0241 | 322 |
| 500 KB–1 MB | 2 | 0 | 6/6 | 70% | 0.0377 | 359 |
| > 1 MB | 4 | 0 | 6/12 | 84% | 0.0356 | 185 |

**Reference: `z-ai/glm-5.3-flash`** (`impactbench/eval/data-v6-glm`; reproduces the 2026-11-23 dashboard numbers 7 / 6 / 0)

| Changed functions | Commits | Caught | Majority | Explained | Valid | Coverage | Out tok | Checks | Mean $ | Mean s |
|---|---|---|---|---|---|---|---|---|---|---|
| ≤ 10 | 12 | 7 | 6 | 7 | 35/36 | 78% | 11,736 | 6.9 | 0.0085 | 397 |
| 11–25 | 10 | 6 | 6 | 4 | 30/30 | 71% | 11,572 | 10.2 | 0.0217 | 405 |
| > 25 | 9 | **0** | 0 | 1 | 21/27 | 67% | 10,638 | 9.4 | 0.0293 | 433 |

| Payload (as sent) | Commits | Caught | Valid | Coverage | Mean $ | Mean s |
|---|---|---|---|---|---|---|
| < 50 KB | 8 | 6 | 23/24 | 81% | 0.0075 | 392 |
| 50–250 KB | 13 | 5 | 39/39 | 68% | 0.0170 | 459 |
| 250–500 KB | 4 | 2 | 12/12 | 61% | 0.0227 | 340 |
| 500 KB–1 MB | 2 | 0 | 6/6 | 73% | 0.0352 | 698 |
| > 1 MB | 4 | 0 | 6/12 | 88% | 0.0349 | 212 |

- Neither model catches anything above 25 changed functions or above 500 KB.
- The 6 invalid reports in the > 25 band are excalidraw-19 (3.0 MB) and excalidraw-20 (4.9 MB), 3 runs each: no report at all ("input too large").
- Output does not grow with the change: about 11–12K tokens for GLM and 2–3K for Luna in every band. Each changed function gets less attention as the change grows.
- Coverage in the > 1 MB band looks high only because just the valid reports are audited there.

### Payload by section (31 commits, no LLM)

Bytes per section of the report payload (`buildLLMPayload`), summed over all commits, as sent today and in the
lossless compact encoding from `tools/impactbench-large-payload.mts` (the R-2 candidate). Tokens are estimated at 4 bytes per token.
The system instruction adds 7.6 KB per call.

| Section | All 31: sent KB | Share | Compact KB | > 25 band (9): sent KB | Share | Compact KB |
|---|---|---|---|---|---|---|
| `changes.blastRadius.paths` | 11,001 | 67% | 2,780 | 8,418 | 69% | 2,123 |
| `changes.blastRadius.entities` | 1,586 | 10% | 364 | 1,211 | 10% | 279 |
| `changes.productionDependents` | 1,364 | 8% | 0 (derived from `sourceRole`) | 1,057 | 9% | 0 |
| `applicationContext.changes` | 495 | 3% | 495 | 290 | 2% | 290 |
| `changes.terminalDependents` | 433 | 3% | 95 | 299 | 2% | 66 |
| `changes.change.diff` | 406 | 2% | 406 | 234 | 2% | 234 |
| `changes.testDependents` | 223 | 1% | 0 | 154 | 1% | 0 |
| **Total** | **16,437** (~4.2M tokens) | | **5,070** (3.2×) | **12,206** | | **3,547** (3.4×) |

- Blast-radius paths and the dependent lists are about 89% of what we send. The changed code itself (diff, added and removed code) is under 5%.
- Compact is 2.5× smaller in the ≤ 10 band and 3.4× in the > 25 band. On the very smallest commit it is 7% *larger*,
  because of the fixed encoding text and entity table; R-2 should send the as-sent form when that is smaller.
- The two "no report" commits shrink to 890 KB (excalidraw-19, from 3,049) and 1,299 KB (excalidraw-20, from 4,857),
  about 228K and 333K estimated tokens. Compaction alone may not fit them into every model's window, which is why R-10 and R-3 follow.

### Reproduce

```
# Band tables (prints them after the variant and cost tables; adds "bands" to summary.json in --data)
node --import tsx tools/impactbench-report-eval.mts summary --data <copy of impactbench/eval/data-v5> \
  --grades impactbench/eval/data-v6-glm/hand-grades-glm-vs-luna.jsonl --grades-model luna
# Section table per commit (needs the evidence files from the `evidence` command)
node --import tsx tools/impactbench-report-eval.mts sections --work <work dir> [--json <file>] [ids...]
```

`summary` rewrites `summary.json` and `cost-time.csv` in its `--data` directory, so run it on a copy to keep a committed data set unchanged.

## Shared graph index (R-1, 2026-11-24)

`buildGraphIndex` (`packages/analyzer/src/graph-index.ts`) is built once per report run in `generateQAReport` and shared by
the context pack's surface lookup and the code lookup tool. It covers entity by ID and by file, relations by type in both
directions, distinct caller counts, consumer sets for a group of IDs (for R-10), and surfaces by entry entity.
`findSurfacesForEntity` keeps its signature and delegates to a one-off index.

**Outputs are byte-identical.** The LLM payload, the compact payload, code lookup results for every changed entity, and
surface lookups were hashed on all 19 corpus evidence files before and after the change. Surface lookups covered every
entity of excalidraw-16 (3,441 entities, 1,628 of which reach a surface) with a real application map. All hashes match,
both with each caller building its own index and with one shared index.

The surface lookup no longer rebuilds the reverse relation map for each changed entity, so it scales with relations once
rather than changes × relations (excalidraw-16: 7,572 graph and 2,158 map relations):

| Changed entities | Before | After |
|---|---|---|
| 41 | 28 ms | 5 ms |
| 100 | 24 ms | 5 ms |
| 400 | 87 ms | 7 ms |

Code lookup setup was already about 2 ms on excalidraw-19/20 and is unchanged.
