# Analyzer Isolation Completion and Remediation Plan

Status: **Partially implemented. Not release-ready.**

The implementation review invalidated the previous blanket completion statement. Passing the existing tests does not prove the mandatory acceptance gates. This document replaces the previous checked-off checklist with an ordered, file-by-file remediation specification. Nothing below is complete merely because its implementation already exists in part.

## 1. Objective and Scope

The analyzer must build from its own source, install from a real package artifact, import without side effects, and analyze an unrelated repository without the workspace root, reporting, visualizer, backend, fixture project, LLM credentials, or network access after installation.

```text
PR event -> exact CI checkout -> Analyzer -> versioned evidence.json
                                                  |
                                                  v
                                           CI submission adapter
                                                  |
                                                  v
                                    Proposed backend -> LLM -> DB -> dashboard
```

The hosted API, database, dashboard, repository cloning service, new language support, new entity/relation types, and graph identity redesign remain out of scope. Package delivery is mandatory; no container is implemented or claimed.

Preserve two-pass extraction, existing entity IDs, caller-to-callee CALLS edges, reverse impact traversal, per-path cycle detection, alternative paths, clipped changes, deletion attribution, terminal-dependent semantics, test callers, and depth six. Do not fix isolation by expanding extraction scope or weakening regression tests.

## 2. How to Execute This Document

- [ ] Start by recording `git status --short` and preserve all unrelated changes. Do not commit, publish, amend, or reset anything without permission.
- [ ] Read the named symbol before each edit. Line references below describe the reviewed version; symbols and behavior are authoritative after lines move.
- [ ] Execute units R1 through R10 in order. Within a unit, follow numbered edit instructions in order.
- [ ] Make prerequisite package exports, dependency declarations, and script wiring when the introducing unit first needs them; R8 audits and finalizes that metadata. Cross-package acceptance tests assigned to later units remain pending until those consumers exist; they must not block the introducing unit's own local regression gate or be marked passed prematurely.
- [ ] Add a regression that fails against the reviewed behavior before fixing that behavior where feasible.
- [ ] Mark an item complete only after its implementation, owning tests, source/test typechecks, and specified acceptance checks actually pass.
- [ ] Keep reporting tests offline with injected clients or mocked transports. Do not load real provider credentials in tests.
- [ ] Record commands, exit codes, runtime versions, test counts, and log locations in section 15. Never substitute a configured CI workflow for an executed result.
- [ ] If a requirement cannot be met, leave it pending and record the exact blocker and user-visible impact. Do not silently weaken this specification.
- [ ] Stop for clarification if another person's edits directly conflict, if an artifact has external consumers requiring migration, or if the two persistent fixture contexts differ.

## 3. Fixed Behavioral Decisions

These decisions remove ambiguity from implementation. Changing one requires updating its tests and this document explicitly.

| Area | Required behavior |
| --- | --- |
| Library comparison | Required discriminated union: `{ mode: 'commit', base, head }` or `{ mode: 'working-tree', base }`. Working-tree base may default to HEAD only when absent, not when blank. Reject extra contradictory comparison keys at runtime. |
| CLI comparison | Explicit flags take precedence. Only CLI orchestration reads BASE_SHA/HEAD_SHA. An incomplete environment pair is an error, not a fallback. With neither pair supplied, retain documented HEAD~1/HEAD default. |
| Commit source | HEAD must equal resolved head. Reject tracked dirtiness and relevant untracked source. Exclude ignored untracked files. Never label local source as committed source. |
| Working-tree source | Include tracked files and nonignored untracked supported source; new untracked source must also produce additions/change evidence. Exclude ignored untracked files. Tracked files remain eligible even if later matched by ignore rules. |
| Exclusions | Target-relative file/directory paths resolved against the target, never the caller's CWD. Reject absolute paths, parent traversal, and target escape. Apply consistently to discovery, changes, dirtiness checks, and content identity. Record them in evidence. |
| Snapshot | Capture the source/configuration inputs used by the compiler, diff, and hash consistently. Detect relevant content/inventory/HEAD changes and fail before publication. HEAD equality alone is insufficient. |
| Evidence | One authoritative envelope contains graph, changes, impacts, provenance, diagnostics, and limitations for all four successful outcomes. Operational errors are not empty successes. |
| Evidence version | Treat the unshipped shape as a draft only after checking consumers. Retain `graphentra-evidence`/`2.0` for draft corrections if unshipped; otherwise introduce a new version with an explicit migration boundary. |
| Output | `--output` always names one evidence file, regardless of extension. Default: `<target>/.graphentra/evidence.json`. No suffix-based directory inference. |
| Reporting flag | `--report` remains QA Markdown on legacy/local reporting commands. The deterministic CLI rejects it with guidance to `npm run report`; it must not silently mean deterministic Markdown. |
| Context onboarding | Existing persistent context is loaded and validated without reading all source. Missing context requires explicit `--generate-context` in the local reporting command. Backend reporting never fabricates context or fetches the repository implicitly. |
| Report association | Every new JSON/Markdown QA report carries the exact evidence identity. Visualizer attaches QA only when that identity matches, not merely HEAD. |
| Submission redirects | Reject all 3xx responses. Do not follow redirects, even same-origin; forward neither credentials nor evidence to a second destination. |
| Submission transport | HTTPS required; HTTP allowed only with explicit local-development opt-in AND a loopback hostname. Reject URL userinfo, query strings, fragments, and unsupported schemes. |
| Submission result | Proposed contract success is exactly HTTP 202 with a nonempty bounded run ID and `status: 'queued'`. Reject malformed or contradictory success bodies. |
| Comparison policy | Default commit policy is `base-to-head`; working-tree policy is `working-tree`. `merge-base-to-head` must be explicitly selected by orchestration that computed the merge base. Resubmission must preserve or explicitly receive the original policy. |
| Exit codes | Analyzer/local reporting: 0 successful including empty, 1 operational failure, 2 usage/configuration failure. CI runner: 0 queued, 1 analysis/artifact-publication failure, 2 usage/configuration/artifact-validation failure, 3 submission failure. |
| Distribution | Pin analyzer production TypeScript to the tested lockfile version; pin internal release dependencies to exact package versions. One root lockfile for monorepo release verification. |

## 4. File Inventory

### Existing Files to Modify

| Files | Unit and responsibility |
| --- | --- |
| `packages/analyzer/src/contracts.ts`, `errors.ts`, `index.ts` | R1/R3: explicit options, provenance, structured errors, public contracts |
| `packages/analyzer/src/repository.ts` | R1/R2: safe Git, inventory, refs, baseline reads, nested paths |
| `packages/analyzer/src/technical-graph.ts`, `analyze.ts` | R1/R2: captured inputs, exclusions, consistent evidence and outcomes |
| `packages/analyzer/src/change-evidence.ts`, `impact.ts` | R2: path parsing and baseline attribution only; preserve graph algorithms |
| `packages/analyzer/src/validator.ts`, `deterministic.ts`, `evidence.schema.json` | R3: structural/invariant validation and canonical identity |
| `packages/analyzer/src/cli-options.ts`, `cli.ts`, `output.ts` | R4: CLI semantics, atomic publication, all-outcome diagnostics |
| All existing `packages/analyzer/test/*.test.ts` | R1-R4: maintain and extend current regressions; use local disposable repositories |
| `packages/reporting/src/llm-client.ts`, `application-context.ts`, `report-generator.ts`, `contracts.ts`, `index.ts` | R5: injection, context validation/onboarding, report association |
| `packages/reporting/test/llm-client.test.ts`, `context-lifecycle.test.ts`, `qa-evidence.test.ts` | R5: preserve offline regressions; eliminate implicit environment configuration |
| `tools/report.ts`, `src/index.ts`, `src/visualize.ts` | R5: one orchestrator and thin compatibility wrappers |
| `apps/visualizer/src/visualize.ts`, `public/model.mjs`, `public/app.js`, `public/index.html`, `public/styles.css` | R6: validated envelope loading, report association, visible run state |
| `apps/visualizer/test/visualize.test.ts`, `visualizer-model.test.mjs` | R6: strict new-envelope behavior and retained legacy/security behavior |
| `apps/ci-runner/src/contracts.ts`, `submit.ts`, `runner.ts`, `idempotency.ts`, `cli.ts`, `index.ts` | R7: secure submission, metadata/policy validation, errors, retry/resubmission |
| `apps/ci-runner/test/ci-runner.test.ts` | R7: correct misleading test names and strengthen assertions |
| Root and four workspace `package.json` files; `package-lock.json` | R8: scripts, exact versions, exports, distribution metadata |
| Root `tsconfig.json`, `tsconfig.root.json`; workspace `tsconfig.json`, `tsconfig.test.json` files | R5/R8: emitted tools/wrappers, complete checks, no source emission |
| `tools/verify-boundaries.mjs`, `tools/verify-distribution.mjs` | R9: real enforcement and isolated artifact execution |
| `test/integration/legacy-adapters.test.ts` | R5/R6: actual wrappers, current output, and recorded model behavior |
| `README.md`, all four package READMEs, `fixtures/test-project/README.md`, `.gitignore`, fixture `.gitignore` | R8/R10: canonical paths, accurate usage, artifact/context preservation |
| `.github/workflows/ci.yml` | R10: clean matrix verification with least privilege |
| This document | Every unit: accurate checklist and executed evidence |

### New Files to Add

Each listed file must contain working code/tests/documentation, not a placeholder. New helpers below have multiple callers; do not create additional abstractions without a concrete use.

| New file | Purpose |
| --- | --- |
| `packages/analyzer/src/source-snapshot.ts` | Shared immutable input capture, input manifest hashing, and final state checks |
| `packages/analyzer/test/helpers/git-fixture.ts` | Package-local disposable repositories, explicit commits, cleanup, isolated Git environment |
| `packages/analyzer/test/source-snapshot.test.ts` | Ignored/untracked inventory, exclusions, mutation, compiler-input isolation |
| `packages/analyzer/test/import-safety.test.ts` | Subprocess argv/filesystem/process/network tripwires |
| `packages/analyzer/test/fixtures/evidence/valid.json` | Complete deterministic envelope with nonempty impact paths |
| `packages/analyzer/test/fixtures/evidence/no-changes.json` | Valid no_changes envelope |
| `packages/analyzer/test/fixtures/evidence/no-supported-changes.json` | Valid unsupported-change envelope with diagnostic |
| `packages/analyzer/test/fixtures/evidence/no-source-files.json` | Valid empty-source envelope |
| `packages/analyzer/test/fixtures/evidence/invalid-cases.json` | Named mutations and expected rejection categories shared by contract consumers' integration tests |
| `packages/reporting/test/report-boundary.test.ts` | Reject invalid/missing context before provider calls and bind report identity |
| `apps/visualizer/src/evidence.ts` | Serialized-contract reader and consumer invariants, with no compiler/analyzer runtime dependency |
| `apps/visualizer/schema/evidence.schema.json` | Generated checked-in snapshot of the public schema, never independently hand-maintained |
| `apps/visualizer/test/evidence.test.ts` | Strict new-envelope validation and association cases |
| `apps/ci-runner/test/transport.test.ts` | Deadline, truncation, body limits, retry, redirects, HTTPS, redaction |
| `apps/ci-runner/test/cli.test.ts` | CLI parsing, stage-specific exits, recovery path, stdout/stderr behavior |
| `test/integration/report-workflow.test.ts` | Real local workflow with injected fake reporting, evidence survival, persistent context |
| `test/integration/contract-consumers.test.ts` | Identical valid/invalid corpus through analyzer, submitter, and visualizer |
| `test/integration/verification-tools.test.mjs` | Negative tests for boundary/package-content enforcement using temporary copies |
| `tools/build-root.mjs` | Build and generate legacy root executable wrappers without duplicate orchestration |
| `tools/sync-evidence-schema.mjs` | Deterministic schema-copy generation and `--check` drift detection |
| `tools/verify-clean.mjs` | Clean allowlisted source-copy verification; fail fast; retain logs |
| `LICENSE`, `packages/analyzer/LICENSE`, `packages/reporting/LICENSE`, `apps/visualizer/LICENSE`, `apps/ci-runner/LICENSE` | Actual approved ISC license text, not metadata alone |
| `docs/EVIDENCE_CONTRACT.md` | Field semantics, identity projection, source policy, privacy, versioning |
| `docs/CI_SUBMISSION_CONTRACT.md` | Proposed server contract, backend duties, PR example, fork policy |
| `fixtures/test-project/legacy-examples/coherent/technical-graph.json` | Synthetic legacy graph 1.0 with two functions and one CALLS edge |
| `fixtures/test-project/legacy-examples/coherent/analysis.json` | Synthetic legacy analysis 1.1 with matching graph entities, HEAD, changes, and recorded impact path |
| `fixtures/test-project/legacy-examples/coherent/README.md` | Labels the coherent bundle synthetic, describes its expected recorded traversal, and distinguishes it from the stale historical artifacts |

### Files Eligible for Removal Only After R8 Checks

- [ ] Remove the duplicate root `visualizer/` files only after verifying equivalence, moving references, and proving installed assets work.
- [ ] Remove the duplicate root `test-project/` files only after comparing every file, preserving persistent context and unique artifacts, and proving no unrelated repository is being removed.
- [ ] Do not delete `fixtures/test-project/.graphentra/application-context.json` or regenerate it as cleanup.
- [ ] Remove unused source-directory generated JS/declarations only after proving they are emitted duplicates. Keep intentional browser JavaScript.

## 5. R1: Git Inputs, Inventory, and Snapshot Alignment

### Ordered Edits

1. In `contracts.ts`, retain the comparison discriminator and add explicit recorded analysis options for normalized exclusions and source policy. Require a content identity for every successful envelope, including empty/commit outcomes; it must identify relevant captured input, not simply repeat HEAD.
2. In `errors.ts`, add stable codes for invalid options, Git timeout, missing Git, unavailable history, invalid target, revision mismatch, dirty tracked/untracked source, changed source during analysis, baseline failure, and unsupported external inputs. Preserve `cause` internally without embedding raw credentials/source in CLI diagnostics.
3. In `repository.ts:createRepositoryContext` (reviewed lines 31-84), validate comparison/options before expensive work. Reject blank refs, option-like refs, extra contradictory comparison keys, invalid timeout values, and invalid exclusions. Canonicalize target and repository paths; preserve missing-Git/timeout errors instead of rewriting all failures as INVALID_TARGET.
4. In `executeGit`, retain argument arrays, bounded output, and an explicit timeout; pipe stderr rather than leaking Git output. Use `rev-parse --verify --end-of-options <ref>^{commit}` for user refs. Resolve requested refs once and reuse immutable SHAs in all subsequent reads. Recheck only checkout HEAD for alignment, not mutable requested branches.
5. For all diff operations, pass `--no-ext-diff`, `--no-textconv`, `--no-color`, a fixed context size, explicit rename behavior, and literal pathspec semantics. Do not permit repository Git configuration to change prefixes or execute helpers. Do not run target installation/lifecycle scripts.
6. Replace newline/quoted porcelain filename parsing with NUL-delimited Git inventory. Obtain tracked files and nonignored untracked files separately; Git C-quoted status output must not determine eligibility. Treat tracked deletions/renames and supported suffixes explicitly.
7. Apply the same target-relative exclusion predicate to files AND directories before discovery, dirty/untracked rejection, change attribution, and hashing. Keep default generated-directory exclusions explicit and documented. No hidden exclusion derived from where the analyzer package is installed.
8. Add `source-snapshot.ts`. Capture sorted eligible file names and exact bytes before compilation. Capture relevant tsconfig/package-resolution inputs and a manifest of compiler reads, including dependencies/declarations actually consulted. Compiler reads of target inputs must use captured bytes, not fresh reads that can disagree with the hash/diff.
9. Bound compiler configuration discovery to the target/repository: do not search an unrelated parent workspace for tsconfig or resolve source from a sibling host directory. Support repository-contained configuration/dependencies and package-installed standard libraries. Reject external symlink/configuration inputs that cannot be safely captured; provide an actionable diagnostic rather than silently using host-specific input.
10. In `technical-graph.ts`, accept the captured file inventory/compiler host. Preserve the two extraction passes and relationship algorithms. Reject ambiguous duplicate entity IDs before a Map overwrite can produce apparently valid evidence. Remove the legacy `analyzerRoot` discovery fallback.
11. In `analyze.ts`, capture inputs before extraction; produce graph, baseline attribution, and changes from the captured comparison/input. For working-tree diffs, verify the source manifest and diff remain aligned with the capture before publishing. Record the captured identity, not a hash first computed after graph extraction.
12. Before every successful return, including empty outcomes, recapture relevant inventory/content/configuration and check HEAD and tracked state. Reject changes with SOURCE_CHANGED. Do not claim the API supports concurrently modified checkouts beyond these checks; callers must not deliberately mutate the checkout during a run.
13. Validate comparison/history even if there are zero source files. Classify unavailable ancestors in shallow history with fetch guidance; do not silently return empty evidence.

### Tests and Gate

- [ ] Add package-local Git fixture helper; remove repeated helpers from analyzer tests without reducing assertions. Use explicit commits, disabled signing/hooks, no inherited GIT_DIR/GIT_WORK_TREE, and clones or fixed dates when identical SHAs are required.
- [ ] Test matching/wrong HEAD, invalid/blank/contradictory refs, shallow missing history, missing Git, timeout, and baseline-read errors by stable code.
- [ ] Test ignored untracked TypeScript, quoted/non-ASCII untracked filenames, tracked files matched by ignore rules, excluded files/directories, and nested targets.
- [ ] Test a configured textconv/external-diff helper that writes a marker: analysis must not execute it and must still detect the change.
- [ ] Test content modification, addition, deletion, configuration mutation, and HEAD mutation during analysis, including empty outcomes. Reject instead of publishing mixed evidence.
- [ ] Test a parent-directory tsconfig and sibling source that would otherwise contaminate extraction. Verify identical cloned repositories in unrelated locations remain equivalent.
- [ ] Preserve A/B/A and explicit-request environment-independence tests. Run source/test typechecks and all analyzer tests.

## 6. R2: Paths, New Files, and Outcome Correctness

### Ordered Edits

1. In `change-evidence.ts:parseGitDiff` (reviewed lines 34-44), replace JSON.parse-as-Git-decoder logic. Parse Git patch header delimiters correctly, including unquoted trailing tab separators, quoted escapes, and octal UTF-8 byte sequences. Do not trim meaningful filename spaces.
2. Distinguish `/dev/null` from actual paths and retain old/new paths independently. Keep hunk line parsing separate from metadata so header-like source lines remain source.
3. In `repository.ts:gitPathToProjectPath` and `getBaselineSource`, retain repository-relative old paths internally. Do not prepend the target to an old path already relative to the repository. Read the old blob by resolved base SHA and its actual repository path.
4. For renames crossing target boundaries, define the target view: incoming rename is an addition, outgoing rename is a deletion, and wholly internal renames preserve old/new attribution. Use fixed Git rename settings and inventory to distinguish these cases. Do not emit `../` paths in target-relative entity/change fields.
5. For supported nonignored untracked files in working-tree mode, synthesize deterministic new-file additions from the captured bytes using the same patch/change shapes. Do not stage files or modify the repository index. Ensure they reach existing entity clipping and impact construction.
6. In `impact.ts:findChangedEntities`, propagate baseline failures for paths known to exist at base; an empty baseline string is a successful read, not a missing-file fallback. Preserve skipped ambiguous/overlapping range diagnostics.
7. In `analyze.ts`, centralize final envelope construction so all returns undergo the same source-state check and contract validation. Outcome precedence: no_source_files for zero current supported source files; otherwise no_changes only for no changes in the included target scope; otherwise no_supported_changes when changes yield no supported current function; otherwise completed.
8. Preserve file evidence/diagnostics for unsupported or deleted source even when there are no current entities. Non-TypeScript-only changes must be diagnosed as outside scope, not described as proof of no risk. Do not attribute wholly deleted functions to surviving neighbors.

### Tests and Gate

- [ ] Extend `change-evidence.test.ts` for spaces, trailing filename spaces, tabs, quotes, backslashes, Unicode, quoted Git headers, and metadata-like code.
- [ ] Extend `revision-alignment.test.ts` for nonempty nested-target comparisons, internal renames, incoming/outgoing target renames, deleted files/functions, and empty baseline files.
- [ ] Add untracked-function addition regression: the function is changed, its callers are correct, and outcome is completed rather than no_changes.
- [ ] Add unsupported syntax/non-TypeScript-only/deleted-last-source cases with explicit expected outcome and diagnostics.
- [ ] Rerun all original clipping, deletion, diamond, cycle, terminal, and depth-six characterizations. No new extraction features are allowed.

## 7. R3: Complete Evidence Contract and Identity

### Ordered Edits

1. In `contracts.ts`, derive ANALYZER_VERSION from package release metadata through a build-safe mechanism that also works in source tests and an installed tarball. Do not maintain two independent version literals. Record the source policy and exclusions agreed in section 3.
2. Expand `evidence.schema.json` to define every nested property using `$defs`: entity, relation, entity change, changed file/hunk/line, changed entity, impact/path, graph metadata/capabilities, comparison, source state, diagnostic, limitations, and target/options. Require types and bounded/nonempty values where appropriate; forbid unknown properties in contract objects.
3. Require integer positive entity ranges, ordered endpoints, supported entity/relation/capability constants, valid SHA strings, content identities, unique file lists, normalized portable relative paths, and mode-dependent comparison fields. Working-tree mode must not carry a resolved head as though it described its source snapshot. Commit source cannot be dirty or include untracked inputs.
4. Make `validator.ts:validateEvidenceEnvelope` total for arbitrary JSON: return structured validation errors, never throw a TypeError from nested nulls or bad arrays. Keep `assertValidEvidenceEnvelope` as the explicit throwing wrapper. Use the schema as the structural source of truth; a pinned JSON Schema validator is allowed in analyzer production dependencies because it is not another Graphentra workspace or provider runtime. Update dependency checks accordingly.
5. Validate graph invariants after structural validation: unique IDs, identity fields agree with file/name, entity files belong to analyzedFiles, relation endpoints exist, relation triples are unique, graph metadata agrees with envelope target/version/checkout, and ranges are integers with start <= end.
6. Validate every embedded entity reference against the canonical graph entity, not just its ID. Require unique changed-entity IDs, exactly one matching impact per changed entity, identical change records between them, and changed lines within the current entity range after deletion anchoring.
7. Validate paths start at the changed entity, end at the stated target, have depth equal to node count minus one in 1..6, contain no repeated node, and follow reverse CALLS at each step. Validate affected entity counts/sets, direct dependents from depth-one paths, terminal semantics, and duplicate paths. Reject malformed evidence; do not reconstruct missing evidence or silently repair it.
8. Validate all outcome combinations from R2: completed requires changes and impacts; all empty/unsupported outcomes prohibit changed entities/impacts; no_changes requires no included changes; no_source_files requires empty current graph inventory. Allow historical deletion file evidence in no_source_files with the appropriate diagnostic.
9. Validate diagnostics' stable code/severity/message and optional relative file/entity. Never permit absolute host paths or authenticated URLs as provenance fields. Source snippets/diffs remain sensitive and are not claimed to be secret-free.
10. In `deterministic.ts`, canonicalize object key order recursively. Define the complete identity projection in `docs/EVIDENCE_CONTRACT.md`: include deterministic provenance, options, graph, changes, impacts, diagnostics, and limitations; exclude only explicitly documented execution timestamps. Normalize unordered producer collections deterministically without reordering path nodes or patch lines. Never omit a field merely to make a failing test pass.
11. Export the schema as `@graphentra/analyzer/evidence.schema.json`, retain public validation/identity APIs, and include schema/license/declarations in the tarball. Create `tools/sync-evidence-schema.mjs` and the visualizer schema snapshot in this unit, before enforcing `--check`. The tool copies from the analyzer package's public schema export, not sibling implementation code; R6 consumes the already-generated snapshot.

### Tests and Gate

- [ ] Add the four valid JSON fixtures and named invalid mutation corpus from section 4. Fixtures must contain no real source secrets or host paths.
- [ ] Exercise malformed objects/null elements, missing fields, extra properties, wrong SHAs/modes, invalid paths/ranges, duplicate IDs/relations, missing endpoints, mismatched references, bad path starts/targets/depth/direction/cycles, incorrect dependent counts, and inconsistent outcomes.
- [ ] Validate the corpus against BOTH the published JSON schema and public runtime validator. Invariant-only failures may pass structural schema checks but must fail runtime validation; document that distinction.
- [ ] Compare cloned repositories and A/B/A output. Reordered JSON object keys and changed execution timestamps preserve identity; changed semantic fields, source state, diagnostics, or exclusions change identity.
- [ ] Unknown artifact kind/version is rejected explicitly. Add regression for `[null]` change records and null path nodes.

## 8. R4: CLI Semantics and Safe Publication

### Ordered Edits

1. In `cli-options.ts`, parse flags strictly: reject unknown short/long options, duplicates, missing values, conflicting modes, blank values, and contradictory flag combinations. Recognize help/version only as actual flags, not by scanning tokens that may be option values.
2. Add `resolveCliComparison(options, environment)` in `cli-options.ts`, with explicit BASE_SHA/HEAD_SHA string values supplied through the environment argument. Export it through analyzer `index.ts`; importing it performs no environment reads. Call it from analyzer CLI and import it from `@graphentra/analyzer` in `tools/report.ts` and the CI runner's analysis command. The library analyzer itself must not read process.env. Do not put backend/PR configuration in this helper.
3. In `cli.ts`, delete `.json` suffix inference. Resolve the complete output pathname, default to `.graphentra/evidence.json`, and write only the authoritative envelope in the deterministic command. Legacy separate graph output belongs at the reporting boundary.
4. Remove deterministic `--report` handling and deterministic Markdown generation from the CLI path. Reject the flag with a message directing users to the local QA command. Do not overload the legacy name.
5. In `output.ts`, add `writeEvidenceFile(filePath, evidence): string` and export it through analyzer `index.ts`. It validates unknown evidence, uses one exclusive (`wx`) random temporary file in the destination directory, and atomically renames it. Import it through `@graphentra/analyzer` from `tools/report.ts` and `apps/ci-runner/src/runner.ts`; retain writeJsonArtifact only for legitimate generic/legacy artifacts. Use private file permissions for sensitive artifacts. Always clean up the invocation's temporary file on failure, without removing unrelated files.
6. Validate before writing. Reject output paths colliding with analyzed inputs or persistent context. In reporting, reject collisions among evidence, context, legacy graph/analysis, and Markdown destinations before any writes.
7. Publish evidence for every successful outcome before announcing success. On failure set the documented nonzero code and do not announce existing evidence as newly created. Leaving a previous valid file intact is allowed, but automatic submission must never read it after a failed run.
8. Print diagnostics and limitations for every outcome before returning, including no_supported_changes and no_source_files. Do not print raw source/diffs by default; preserve any legacy verbose behavior only in the reporting command. No JSON stdout mode is required; if added later, reserve stdout exclusively for JSON.
9. Keep library imports free of argv handling, dotenv, logging, writes, subprocess execution, network calls, and process.exit. CLI entrypoints use a main guard and process.exitCode, not process.exit inside reusable functions.

### Tests and Gate

- [ ] Update `cli.test.ts` and `cli-safety.test.ts`: exact extensionless/uppercase/custom filenames; directory-as-file errors; help/version; option-value edge cases; --report rejection; correct exit codes.
- [ ] Completed run followed separately by each empty outcome replaces old evidence. Failed analysis/writes preserve valid prior JSON but print no publication claim. Place actual stale evidence in the failure fixture.
- [ ] Test unwritable destination, rename failure, preexisting target directory, path collisions, arbitrary CWD, read-only checkout with external output, and no leftover temporary files. Restore permissions during cleanup.
- [ ] Run concurrent reader/writer subprocesses: every observed destination is valid old or valid new JSON, never partial JSON.
- [ ] Add import subprocess tripwires for writes, logging, process exit, subprocess calls, and network; use invalid argv, an empty nonrepository CWD, and scrubbed credentials. Permit only module-loading filesystem reads.

## 9. R5: One Reporting Orchestrator and Context Boundary

### Ordered Edits

1. Make `tools/report.ts:runReport` the only local QA orchestration implementation. Move environment loading inside command invocation, once per invocation; do not call dotenv at module import.
2. Replace duplicated `src/index.ts` orchestration with public re-exports and a thin main-guarded delegation to runReport. Retain existing documented exports and the separate visualizer adapter. Wire `npm run report`, `npm run analyze`, and `npm start` to the same implementation.
3. Preserve `node dist/index.js` and `node dist/visualize.js`. Set root compilation to emit root `src/` and `tools/report.ts` under `dist/src/` and `dist/tools/` using `rootDir: '.'`. Add `tools/build-root.mjs` to run tsc and generate thin `dist/index.js` and `dist/visualize.js` forwarding wrappers with main guards. These are generated outputs, not another hand-maintained orchestrator. Include the root tools in source typechecks; do not emit tests into production output.
4. Handle --help/--version before target validation, dotenv loading, analysis, or provider initialization. Accept --generate-context only on the reporting command, not the deterministic analyzer. Preserve --report as QA Markdown and apply R4 output/collision rules.
5. In `llm-client.ts`, remove process.env reads from exported model constants, credential resolution, and log-level resolution. Inject one options object/client/model into context and report calls from runReport. Retain the default model as a constant fallback in orchestration. Keep bounded transport/semantic retries and existing prompt semantics.
6. Remove unused dotenv dependency from the reporting package. Keep dotenv owned by local orchestration. Migrate tests to explicit fake options instead of environment mutation. Remove redundant string-key/options overloads unless shipped consumers demonstrably require them.
7. In `application-context.ts`, validate loaded/generated context and its semantic references. Never overwrite an existing context during migration. Check for existing context BEFORE reading source; if missing and --generate-context is absent, fail with explicit onboarding instructions after deterministic evidence is saved.
8. When --generate-context is explicitly supplied, disclose that full eligible source is sent to the provider, read only the captured/approved source files, and persist new context atomically without overwriting a concurrently created context. A backend caller without context receives a structured missing-context error, not fabricated context.
9. In `report-generator.ts:generateQAReport`, accept validated evidence plus unknown application context and injected options. Validate both at this public boundary before any provider call. Build reporting payloads from recorded impacts only; never recompute graph evidence.
10. Compute evidence identity once from the validated envelope. Require it in newly generated report results and in buildLegacyAnalysisResult's write path. Add an Evidence Identity line to QA Markdown and evidenceIdentity to analysis.json. Preserve optional identity only in readers for old saved reports.
11. Persist evidence before any context/provider work, including missing credentials or failed context validation. Write legacy graph 1.0 and analysis 1.1 through the reporting adapter, not the analyzer. Any legacy root field must be a portable target representation, never a leaked absolute host root.

### Tests and Gate

- [ ] Add `report-boundary.test.ts`: malformed/missing/unsupported-version context fails before fake provider invocation; different injected models/clients stay independent; identity matches JSON and Markdown reports.
- [ ] Extend context lifecycle tests: existing context bytes/mtime unchanged, no unnecessary source reads, explicit generation only, failure cannot create partial context, concurrent context creation is preserved.
- [ ] Add `report-workflow.test.ts`: fake LLM failure, missing credentials/context, and invalid provider response all leave valid current evidence intact. No real credentials or network access.
- [ ] Exercise source commands AND built legacy wrappers with --help/--version and a disposable nonempty repository. For dotenv behavior, create a temporary .env containing fake credentials/refs and inject a fake client; assert the options actually used. Never load the developer's .env in tests.
- [ ] Verify the 1.0/1.1 legacy outputs, persistent context, report identity, and QA --report semantics. Ensure wrapper imports themselves have no orchestration side effects.

## 10. R6: Strict Visualizer Consumption and Run Display

### Ordered Edits

1. Add `schema/evidence.schema.json` as a generated snapshot from the analyzer's public JSON schema. `tools/sync-evidence-schema.mjs` copies/checks exact contents; include the snapshot in the visualizer tarball. Visualizer must build from its own source/snapshot independently and must not import TypeScript or analyzer runtime.
2. Add `src/evidence.ts` using a pinned JSON Schema validator and consumer-side graph/path/outcome consistency checks. Implement `computeEvidenceIdentity` there against the exact documented canonical projection using Node crypto, without analyzer/compiler imports. Reuse existing consumer checks where possible, but do not copy the extraction/traversal engine. Test acceptance/rejection AND identity parity through the shared integration corpus rather than importing sibling src/dist files.
3. In `visualize.ts:readEvidenceArtifact`, validate the entire envelope before returning it. Attempt read directly; only ENOENT permits legacy fallback. Invalid JSON/schema/invariants/version returns 422, other I/O errors return an operational error. Do not use existsSync to mistake unreadable/invalid evidence for absence.
4. Load graph and recorded impacts from the same envelope. Read optional analysis.json only for QA; attach its QA report only if evidenceIdentity matches the exact validated envelope and the report shape is valid. Ignore mismatched/missing identities on the new-evidence path with a clear warning. Retain HEAD-based legacy warnings only when evidence.json is absent.
5. In `public/model.mjs:prepareData`, preserve outcome, diagnostics, limitations, and provenance in the returned model. Invalid new evidence is an error, not a silent conversion to legacy/what-if mode. Keep existing recorded versus what-if graph behavior unchanged.
6. In `public/app.js:main`, show a distinct status for completed/no_changes/no_supported_changes/no_source_files. Show diagnostics and limitations even with zero nodes/impacts. Explain that unsupported changes are not a no-risk result. Keep valid empty recorded results identifiable, and label optional what-if exploration as simulation.
7. Add accessible outcome/diagnostic markup in `public/index.html` and minimal styles in `public/styles.css` consistent with the existing UI. Use textContent, not raw HTML, for artifact-controlled messages/source/context.
8. Preserve loopback binding, Host/Origin validation, CSP, allowed methods, and the four public asset routes. Schema files and arbitrary filesystem paths must not become public static routes. Resolve assets only from the package's public directory.
9. Add main-guarded --help/--version behavior to runVisualizerCli without binding a port. Derive its version from its own package metadata.

### Tests and Gate

- [ ] New `evidence.test.ts` and `contract-consumers.test.ts` reject the R3 invalid corpus, including missing provenance and inconsistent paths/outcomes, without serving stale legacy data.
- [ ] Test matching identity shows new QA, mismatched/missing identity does not, matching HEAD alone does not, and legacy-only artifacts still use the compatibility path.
- [ ] In `contract-consumers.test.ts`, compare analyzer and visualizer identity calculations for reordered object keys, execution-timestamp-only changes, every semantic projection field, and invalid input. Both identity functions must reject invalid envelopes before association.
- [ ] Test all four outcome models and rendered status/diagnostic content. Verify recorded traversal of actual analyzer-produced evidence, not just an HTTP 200 response.
- [ ] Retain every existing security assertion and add artifact-controlled HTML/script strings to confirm text-safe display.
- [ ] Verify desktop and mobile empty/nonempty views manually or with browser automation; record what actually ran rather than claiming screenshots or browser tests not executed.

## 11. R7: Secure CI Submission and Recovery

### Ordered Edits

1. In `contracts.ts`, validate repository identity, optional positive safe-integer PR number, bounded branch metadata, and comparisonPolicy at runtime. Prefer an opaque repository identity/name; if remoteUrl is retained, reject embedded credentials and sensitive URL components before serialization.
2. In `submit.ts:submitEvidence`, validate evidence and metadata before opening a connection. Enforce section 3 URL rules, including explicit opt-in plus loopback for HTTP. Reject control characters in tokens/headers without printing their values. Validate finite bounded timeout/retry/body-limit options; reject zero/negative/noninteger attempt counts.
3. Build the endpoint from a validated backend base URL. Set redirects to permanent rejection: delete currentUrl/currentToken redirect-following logic. Do not fetch or POST any Location URL.
4. In `executeSingleRequest`, start an absolute timer before DNS/connect/TLS and keep it active through response end. Use a 10-second default deadline per attempt. Destroy request/response on deadline. Limit response bodies to 1 MiB and clean up timer/listeners on every settle path.
5. Reject response error, aborted, and premature close events. Settle the promise exactly once. Handle truncation after headers as a transient transport failure, not a hanging promise or successful process exit.
6. Retry only classified transient failures: deadline/connection reset/temporary transport errors, HTTP 408/429, and configured transient 5xx statuses. Default to three total attempts, reuse exact serialized body and idempotency key, and use bounded delays. Honor Retry-After seconds/date only within a documented cap; invalid values use normal backoff. Do not retry permanent schema/auth/redirect/protocol errors.
7. On success require HTTP 202, valid JSON object, nonempty bounded ID, and exact queued status. Do not coerce missing/failed/unknown statuses into success. Malformed success is a permanent protocol failure with no raw body in diagnostics.
8. Replace response-body/URL interpolation in errors with stable safe codes, status, attempt count, and sanitized request ID when available. Never log the token, URL userinfo/query, serialized request evidence, or echoed backend body by default. Sanitize backend run IDs before terminal display.
9. In `runner.ts`, keep one analyzer invocation, persist the current in-memory validated evidence before submitting, and never read a prior default file on failure. Remove ambiguous outputDir/outputEvidencePath options in favor of one documented evidence file path.
10. Use base-to-head by default for commit analysis and working-tree for working-tree evidence. Add an explicit --comparison-policy option. A caller choosing merge-base-to-head must supply a base computed by its trusted orchestration; the runner must not falsely claim it calculated a merge base.
11. Require comparisonPolicy in the programmatic resubmission request. For CLI commit resubmission require --comparison-policy explicitly; infer working-tree only for working-tree evidence and reject conflicting policies. Document the exact retry command on submission failure with repository/PR/policy/output metadata, but no token.
12. In `idempotency.ts`, hash normalized repository identity, PR, target, resolved comparison, policy, analyzer/schema versions, and canonical evidence identity. Do not allow arbitrary idempotency-key overrides through normal submission options. Exclude credentials/execution timestamps; preserve the same key across automatic retry and explicit resubmission with identical metadata.
13. In `cli.ts`, reject unknown flags, duplicates, positional garbage, partially parsed PR numbers, --head with --working-tree, and analysis flags with --resubmit. Expose --allow-local-http as a value-free flag. Prefer token environment configuration over command-line secrets and document process-list exposure if --token remains.
14. Implement the stage-specific exit codes from section 3 with process.exitCode. On submission failure print the preserved evidence pathname and safe resubmission guidance. Catch the top-level async promise; do not allow an unresolved transport path to exit 0.

### Tests and Gate

- [ ] In the successful mock, parse and validate the actual request body, verify repository/PR/policy/evidence/auth/endpoint/idempotency, and assert exact accepted result.
- [ ] Cover 401 AND 422 separately; malformed JSON, empty ID, missing status, failed/unknown status, wrong success HTTP code, and invalid metadata must fail permanently.
- [ ] Test silent server, trickling body beyond deadline, truncated Content-Length, reset after headers, response error/abortion, oversized response, and final socket/timer cleanup. Bound test durations and close all mock connections.
- [ ] Reject same-origin, cross-origin, and HTTPS-to-HTTP redirects with zero requests to the redirect destination. Replace the old test that expects cross-origin submission to succeed.
- [ ] Verify HTTPS enforcement, missing HTTP opt-in, remote HTTP even with opt-in, invalid URL components, and token/header control characters before network calls.
- [ ] Test 429 Retry-After, transient retry exhaustion, stable body/key, and a spy proving analysis runs exactly once. Resubmission of working-tree and explicit commit-policy evidence must preserve the original key.
- [ ] Prepopulate actual old evidence, force analysis failure, and prove zero HTTP requests. Force submission failure and prove current evidence survives.
- [ ] Capture CLI stdout/stderr for echoed secret/source markers, malformed backend bodies, URL credentials, and run-ID control characters; assert none leak. Assert every stage's documented exit code.

## 12. R8: Build Metadata, Canonical Fixtures, and Licenses

### Ordered Edits

1. Read the installed/lockfile TypeScript version and pin analyzer's production dependency to that exact tested version. Do not assume the manifest range's lower bound is installed. Pin reporting and CI runner analyzer dependencies to the exact analyzer package version. Avoid unrelated upgrades; regenerate only the workspace lockfile.
2. Keep root private and one lockfile. Give each workspace build, source typecheck, test typecheck, test, and prepack scripts. Add root pretest build preparation so `npm ci && npm test` works without a preceding manual build. Analyzer's package-local pretest must prepare its CLI for standalone-source tests; avoid recursive root/workspace script invocation. In root package.json set `build:root` to `node tools/build-root.mjs`, add `sync:evidence-schema` as `node tools/sync-evidence-schema.mjs`, `verify:schema` as `node tools/sync-evidence-schema.mjs --check`, and `verify:clean` as `node tools/verify-clean.mjs`. Include BOTH `test/integration/*.test.ts` and `test/integration/*.test.mjs` in root test discovery. Run schema drift checking inside verify:boundaries so the required final command sequence cannot omit it. Register each script as soon as its tool is introduced, not only at final audit.
3. Ensure root build orders analyzer before reporting/CI runner and builds root wrappers last. Visualizer must also build independently without analyzer dist. Root typecheck must cover all workspace sources, TypeScript tests, and TypeScript tools/adapters; prepare declarations when invoked without prior build if needed.
4. Keep noEmitOnError and separate test noEmit configs. Exclude fixtures/tests from product output. Add actual approved ISC LICENSE files to root and each tarball allowlist; do not invent a copyright holder. Record a licensing blocker if ownership cannot be established.
5. Ensure exports/types/bin fields resolve real emitted files, schema export works, README/license ship, and executable shebangs survive packing. Pin any newly selected schema-validator dependency and lock it. Update boundary/distribution expectations instead of incorrectly claiming TypeScript is the sole possible runtime dependency.
6. Compare root/canonical fixture trees including hidden files. Preserve byte-identical persistent context; stop for a decision on differing context or unique user content. Move reference commands to fixtures/test-project before removing old copies.
7. The current checked-in legacy graph/analysis have mismatched SHAs. Preserve them honestly as a stale-artifact example, not a valid recorded bundle. Add the three coherent example files enumerated in section 4. Use a synthetic fixed matching SHA in both artifacts, two canonical entity records, one caller-to-callee edge, and the corresponding reversed recorded impact path with consistent counts/ranges/change evidence. In `test/integration/legacy-adapters.test.ts`, copy the coherent JSON files into a disposable target's .graphentra directory and assert recorded model traversal and QA loading. Test the historical stale pair separately for rejection/warning. Do not edit historical SHA strings to falsely suggest the old artifacts came from one run.
8. Compare/migrate/delete the duplicate root visualizer assets. Remove old fixture/assets only after tests and reference searches confirm canonical ownership. Never delete unrelated target repositories or persistent application context.
9. Update ignore rules for evidence/graph/analysis generated outputs, while explicitly retaining intended checked-in legacy examples and application-context.json. Ignore tarballs/build output without hiding accidental source-directory emission.

### Tests and Gate

- [ ] In a disposable source copy with no dist/node_modules, run `npm ci && npm test` directly. Also run the full ordered command sequence independently.
- [ ] Deliberately insert one source type error and one TypeScript-test type error in disposable copies: aggregate checks must fail. Remove only temporary verification changes.
- [ ] Change an analyzer export in a disposable copy, rerun root build, and assert a consumer sees the new runtime value. Do not rely on old dist output.
- [ ] Verify actual built root wrappers, preserved exports, CLI help/version, coherent legacy fixture loading, and explicit rejection/warning for stale examples.
- [ ] Search for old fixture/asset paths and sibling src/dist imports. Confirm no duplicate engine, orchestration, assets, or copied root unit suites remain.

## 13. R9: Trustworthy Boundary and Distribution Gates

### `tools/verify-boundaries.mjs`

1. Resolve import targets relative to each source file and its workspace owner. Detect static imports/exports, side-effect imports, require, and literal dynamic imports; do not rely solely on regexes containing `from` or `packages/`.
2. Reject imports resolving to a sibling src/dist path, including `../../analyzer/src/index`, package subpaths not publicly exported, and root implementation imports from products. Inspect all relevant tsconfig extends/paths and reject sibling implementation aliases.
3. Inspect dependencies, optionalDependencies, peerDependencies, and devDependencies with role-specific allowlists. Analyzer must not depend on another Graphentra workspace; visualizer runtime must not load analyzer/compiler/reporting. Root integration tests may use public package exports; each package's tests may use its own source.
4. Reject generated JS/declarations in TypeScript-only source trees while allowing intentional browser assets. Verify exact internal release versions and schema snapshot parity.
5. Add negative tests in `verification-tools.test.mjs` that mutate temporary source copies with every forbidden import/config/dependency form. Assert nonzero exit and the offending file, without changing the real workspace.

### `tools/verify-distribution.mjs`

1. Use argument-array subprocesses with explicit CWD, deadlines, captured logs, and fail-fast errors. Create packing/install directories outside the workspace. Clear NODE_PATH and provider credentials for isolation checks. Clean temporary outputs in finally; retain failure logs without sensitive payloads.
2. Build and pack ALL FOUR workspaces into the temporary pack destination. Read `npm pack --json` manifests rather than parsing the last stdout line. Inspect actual tarball entries, not just source allowlists.
3. Require runtime entrypoints, exported declarations, package metadata, README, LICENSE, schema where applicable, and CLI executables. Reject `.env` variants at any depth, fixtures, tests, source directories not intentionally distributed, node_modules, local artifacts, symlink escapes, and unrelated application files. Add negative package-content fixtures to verifier tests.
4. Install analyzer alone with production dependencies in a consumer directory outside the workspace. Assert the dependency tree has no provider/reporting/visualizer dependencies. Exercise public exports and actual API usage through TypeScript declarations, not just unused imports. Match ANALYZER_VERSION to installed package metadata.
5. Invoke the installed analyzer binary directly for help/version and a nonempty before/after analysis of a separate disposable repository. Check expected changed entity, caller direction, impact paths, provenance, and full envelope validity.
6. Perform import safety and analysis checks with credentials removed and network tripwires on Node HTTP/HTTPS/net/TLS/fetch/DNS. On Linux run the installed analysis in a network-disabled environment as the strongest check; on other platforms clearly label tripwire coverage and do not claim an OS network sandbox. No dependency installation belongs inside the offline portion.
7. Install visualizer independently. Invoke its installed binary, wait for its loopback URL, fetch all four real assets and /api/data using fresh analyzer evidence, and verify content/MIME/CSP/Host checks plus recorded model behavior. Merely checking file existence is insufficient. Terminate the process and close connections in finally.
8. Install reporting and CI runner with their locally packed analyzer release in a separate consumer, without workspace symlinks or registry substitution for the internal analyzer. Import declarations/runtime, run an injected offline report, and invoke the installed CI binary against a mock backend for submission and resubmission.
9. Copy ONLY analyzer source/tests/config/schema/README/LICENSE/package metadata outside the workspace. Install its declared build dependencies, then build, typecheck source/tests, and test. Separately copy ONLY visualizer source/public/schema/tests/config/README/LICENSE/package metadata and run its declared install/build/typecheck/test scripts with no analyzer source/dist or workspace resolution. Its checked-in schema snapshot must suffice; schema regeneration is a monorepo maintenance operation, not a standalone visualizer build prerequisite. Verify neither source build needs root config/history/fixtures. Explain that standalone npm install is not lockfile-reproducible release verification; the root lockfile supplies the latter.
10. Make every printed success correspond to an executed assertion. Print separate results for installed visualizer startup, actual asset serving, offline analysis, reporting install, runner install, and standalone source build.

### `tools/verify-clean.mjs`

1. Copy an allowlist of intended source/config/docs/tests, including untracked intended changes, to a fresh external directory. Exclude .git, node_modules, every dist/build output, local .env, tarballs, and unintended artifacts. Preserve checked-in example/context files deliberately, not by a blanket hidden-file exclusion.
2. Execute `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, `npm run verify:boundaries`, and `npm run verify:distribution` sequentially and stop at the first nonzero exit.
3. In a second fresh copy, execute `npm ci` followed directly by `npm test` to establish fresh-test readiness separately from build-first readiness.
4. Save environment versions, command exit codes, unique test counts, and logs; report the failing step accurately. Never continue a shell sequence after failed cleanup/install and then call the entire sequence passing.

### Gate

- [ ] Boundary positive and negative tests pass.
- [ ] All four tarballs install and their public interfaces run without workspace resolution.
- [ ] Installed analyzer nonempty/offline/import-safety checks, real visualizer assets, mock CI submission, injected reporting, and standalone analyzer-source checks pass.
- [ ] Both clean-copy sequences pass and preserve usable logs.

## 14. R10: Documentation, PR Safety, and CI

### Ordered Edits

1. Update root README with actual ownership, build/test commands, deterministic versus QA commands, CLI exit codes, and package-only delivery. Remove claims contradicted by pending gates.
2. Update analyzer README's library example to include `mode: 'commit'`. Document exact checkout/head alignment, shallow-history fetch responsibility, nested targets, exclusions, ignored/untracked policy, symlink/external-input policy, file-only output, empty outcomes, and inherited rename/deletion/unsupported-syntax limitations.
3. Write `docs/EVIDENCE_CONTRACT.md` from R3's implemented schema and identity projection. Explain versioning, excluded timestamp fields, source/config/dependency identity, and why relative paths do not make snippets/diffs nonsensitive.
4. Update reporting README with injection, context schema validation, explicit local onboarding/data exposure, evidence-first persistence, exact report association, legacy adapters, and missing-context behavior. Do not imply a backend can derive whole-repository context from evidence alone.
5. Update visualizer README with strict evidence precedence, absent-only legacy fallback, identity-bound QA, empty-state display, recorded versus what-if behavior, package-local assets, and loopback security.
6. Write `docs/CI_SUBMISSION_CONTRACT.md` and link it from CI runner README. Label `/v1/analysis-runs` as PROPOSED, not an available service. Define payload, exact accepted response, idempotency, deadlines/retries, no redirects, transport policy, safe errors, stage exit codes, and explicit resubmission policy.
7. Document backend duties: repository/PR authorization, strict schema/invariant validation, idempotent run creation, report-to-evidence association, context onboarding, and ordering rules so an older PR-head result cannot replace a newer result. Treat source/context as untrusted data, not model instructions.
8. Replace the workflow example with exact-head checkout, sufficient history, explicit merge-base computation from event SHAs, and pinned adapter/analyzer delivery. Pass event values via environment variables rather than interpolating branch text into shell code. Quote Git arguments, disable persisted checkout credentials, and never run target lifecycle scripts with the submission secret.
9. Gate same-repository submission, use contents: read and narrowly scoped backend credentials, and explicitly disable fork submission initially. Do not implement or claim a trusted fork handoff unless separately validated. Never use pull_request_target to execute arbitrary PR code with secrets.
10. Use an output path under the runner's temporary directory, not an untrusted checked-in default artifact. Upload only a successfully created current evidence artifact, including when submission alone failed; do not upload a preexisting artifact under `if: always()` after analysis failure. Document artifact sensitivity, visibility, and retention.
11. Update `.github/workflows/ci.yml` to run the full clean checks on supported Linux/macOS and Node versions. Select supported Node ranges consciously rather than claiming every future Node release from `>=20`; if retaining Node 20 compatibility, label its support policy accurately. Use least permissions, no provider credentials, no cached workspace dist outputs, and trusted pinned actions where practical.
12. Record actual matrix results only after CI runs. A local Darwin/Node 26 pass does not prove Linux/Node 20/22 execution. Leave unavailable platform checks pending with the release impact stated.

### Gate

- [ ] README commands and examples execute with disposable repositories/fake providers.
- [ ] PR example is reviewed for shell injection, secret exposure, exact-head history, stale artifact upload, and reproducible tool installation.
- [ ] Linux and every claimed platform/runtime validation passes, or completion remains pending.
- [ ] Final diff review finds no leaked credentials, accidental source output, duplicate implementations, unpreserved context, or weakened tests.

## 15. Verification Record and Acceptance Matrix

### What the Review Actually Established

| Check | Observed result | What it does NOT prove |
| --- | --- | --- |
| Existing tests | 102 passed on the reviewed Darwin/Node v26.5.0 workspace | No proof for missing regression cases or fresh-install tests |
| Aggregate typecheck | Passed with existing workspace outputs | No proof of clean declaration preparation |
| Existing boundary verifier | Passed | Its current matcher misses forbidden imports/configurations |
| Tarball dry-run inspection | Executed; license files absent | Not a release/distribution pass |
| Previous distribution execution | Existing script reported success for its implemented checks | Did not execute installed visualizer HTTP/assets, packed reporting/runner, or network-blocked analysis |
| Review reproductions | Confirmed analyzer provenance/validation/path and submission transport failures | These are failures to fix, not accepted limitations |
| Linux/other configured Node matrix | Not executed during review | Configured CI is not evidence of passing |

The earlier clean-copy execution is historical evidence of that command sequence only. It must be repeated after remediation with fail-fast automation. The previously recorded exact npm/TypeScript/OS versions were not all established by captured version commands; capture them explicitly on the next run.

### Acceptance Matrix

| Requirement | Required proof | Current remediation status |
| --- | --- | --- |
| Independent boundary | R9 positive/negative import/dependency tests and isolated installs | Pending R8/R9 |
| Standalone analyzer source | External analyzer-only build/source-test checks | Rerun required R9 |
| Import safety/offline operation | Scrubbed subprocess tripwires and Linux network-disabled analysis | Pending R4/R9 |
| Per-run isolation | A/B/A plus immutable-source snapshot tests | Existing A/B/A passes; R1 pending |
| Explicit options/revisions | Invalid shapes, resolved refs, missing history/Git/timeouts | Pending R1 |
| Source correctness | Ignored/untracked/exclusion/path/mutation regressions | Failing reviewed cases; R1/R2 pending |
| Complete portable evidence | Four outcomes, full schema and invariants, cloned-location equivalence | Partial; R2/R3 pending |
| Atomic safe publication | Collision, failure, all-empty replacement, concurrent readers, read-only target | Partial; R4 pending |
| Algorithms preserved | Original clipping/traversal/identity regressions retained | Existing tests pass; rerun R2 |
| Reporting isolation | No import-time config, injected options, context boundary | Partial; R5 pending |
| Evidence survives reporting failure | Actual local orchestration failure tests | Pending R5 |
| Report association | JSON/Markdown identity and visualizer exact-match acceptance | Pending R5/R6 |
| Visualizer current/legacy behavior | Strict corpus, actual producer recorded output, visible outcomes, coherent legacy bundle | Partial; R6/R8 pending |
| Canonical fixtures/assets | Reference migration and safe removal of duplicate trees | Pending R8 |
| CI submission | Strict mock payload/protocol/security/recovery/CLI tests | Failing reviewed cases; R7 pending |
| Fork safety | Reviewed same-repository-only workflow and no stale uploads | Partial; R10 pending |
| Installed binaries/assets | Direct installed CLIs, real HTTP assets, public TS consumer | Partial; R9 pending |
| Clean-checkout reliability | Full sequence AND ci-then-test in two fresh copies | Rerun required R8/R9 |
| Accurate docs/platform support | Executed examples, honest records, actual platform matrix | Pending R10 |

### Completion Log Template

Add one row for each actual execution. Do not prefill Pass.

| Date | Unit/check | Command | OS / Node / npm / TypeScript / Git | Exit code and count | Log path or CI URL | Remaining gaps |
| --- | --- | --- | --- | --- | --- | --- |
| Not run | Remediation final sequence | `npm run verify:clean` (add in R9) | Pending capture | Pending | Pending | R1-R10 not yet implemented/verified |

### Final Sign-Off

- [ ] Every R1-R10 edit and gate is implemented and verified; each review finding has a regression test or explicit documented acceptance decision.
- [ ] All source/test checks, offline tests, boundary negative tests, independent source build, packed package checks, and clean-copy sequences pass.
- [ ] Every supported runtime/platform has an executed result, not only a workflow entry.
- [ ] Persistent context and unrelated user changes remain preserved; no commit or publication was performed without approval.
- [ ] Update this status to Completed only after all mandatory gates pass and the log identifies the exact verified revision/worktree snapshot.

Completion statement: **Not complete. This document is the implementation specification for closing the reviewed gaps, not evidence that the fixes have already been made.**
