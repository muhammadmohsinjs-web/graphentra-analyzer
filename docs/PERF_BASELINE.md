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
