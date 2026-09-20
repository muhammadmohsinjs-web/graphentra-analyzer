# Graphentra Analyzer: Product and Implementation Plan

**Prepared:** 20 September 2026

**Implementation baseline:** `b3e009f590b37793418004d28a6f4e7353e4a82a`

**Audience:** Founders, analyzer engineers, backend and dashboard engineers, QA, verification engineers, and coding agents.

**Scope:** The change-impact analyzer is the primary product described here. Dashboard, backend APIs, and change-driven Playwright generation are downstream integrations, not prerequisites for making the analyzer useful.

**Status:** Repository-grounded specification and proposed roadmap. Only Section 4 describes verified current implementation. Future capabilities, technology choices, estimates, prices, and success targets are proposals unless explicitly stated otherwise.

> Graphentra should explain what changed, which supported dependencies and application behaviors may be affected, why they deserve attention, and what remains unknown. It must not confuse potential impact with a defect, successful analysis with successful testing, or missing evidence with safety.

## Contents

1. [How to use this document](#1-how-to-use-this-document)
2. [Product vision and boundaries](#2-product-vision-and-boundaries)
3. [Users and personas](#3-users-and-personas)
4. [How the current analyzer works](#4-how-the-current-analyzer-works)
5. [Requirements and acceptance criteria](#5-requirements-and-acceptance-criteria)
6. [Target analyzer architecture](#6-target-analyzer-architecture)
7. [Multi-language and framework strategy](#7-multi-language-and-framework-strategy)
8. [Graph, change, and impact algorithms](#8-graph-change-and-impact-algorithms)
9. [Application context and AI](#9-application-context-and-ai)
10. [Output contracts and reporting](#10-output-contracts-and-reporting)
11. [Technology decisions](#11-technology-decisions)
12. [Backend, storage, and APIs](#12-backend-storage-and-apis)
13. [Dashboard integration](#13-dashboard-integration)
14. [Change-driven Playwright generation](#14-change-driven-playwright-generation)
15. [Security and privacy](#15-security-and-privacy)
16. [Testing, evaluation, and quality gates](#16-testing-evaluation-and-quality-gates)
17. [Implementation roadmap](#17-implementation-roadmap)
18. [Business and commercial plan](#18-business-and-commercial-plan)
19. [Operations and cost management](#19-operations-and-cost-management)
20. [Risks and open decisions](#20-risks-and-open-decisions)
21. [Instructions for implementation agents](#21-instructions-for-implementation-agents)
22. [Glossary and references](#22-glossary-and-references)

## 1. How to Use This Document

This is a long-lived product context document, not an instruction to implement every feature in one change. Each milestone should become small, independently verifiable work items.

Use these labels consistently in issues, documentation, and reports:

| Label | Meaning |
|---|---|
| Current | Present in the inspected source, with the limitations described here. |
| Proposed | Recommended design that has not been implemented or finally approved. |
| Experimental | Implemented later for evaluation, but not yet a supported customer promise. |
| Supported | Passes a published capability-specific test and evaluation gate. |
| Deferred | Intentionally outside the next delivery scope. |
| Hypothesis | A business or quality assumption that needs measurement. |

Read [README.md](../README.md) for present-day usage. The existing [Business and Technical Playbook](Graphentra_Business_and_Technical_Playbook%20%281%29.md) provides broader company and verification-team context. This document expands the analyzer plan and grounds it in this checkout; it does not certify that the broader playbook has been implemented.

When sources disagree, current code and reproducible tests determine current behavior. Explicit product decisions determine future direction. A proposal in either document is not evidence that a feature exists. Record approved design changes in an architecture decision record rather than silently treating all suggestions as commitments.

The implementation baseline above makes this snapshot auditable. Future agents must re-read the relevant code before relying on the current-state section.

## 2. Product Vision and Boundaries

### 2.1 The problem

Software changes are local in a diff but often broad in consequence. A shared validation function may serve multiple endpoints; an endpoint may serve several screens; an authorization rule may affect different user roles. Reviewing only the ticket or modified file misses these connections. Running every test or manually checking every journey is expensive and may still miss meaningful behavior.

Graphentra's first job is regression-planning intelligence: produce a defensible, reviewable scope of attention from a specific change.

### 2.2 Questions the analyzer should answer

1. What repository revisions and configuration were analyzed?
2. Which files and semantic entities changed, including additions, deletions, and contract changes?
3. Which supported dependencies connect those entities to other code?
4. Which application surfaces and approved business journeys may be affected?
5. Which application-user personas may encounter those surfaces?
6. Why is each recommendation present, and how strong is its evidence?
7. Which existing tests are candidates for verification, and what do we actually know about their coverage?
8. What should a person check, or what scenario could a test generator propose?
9. Which changes, relationships, languages, and dynamic behaviors could not be analyzed?

### 2.3 The destination

The long-term product supports many languages and frameworks through a common evidence model. A developer can analyze a PR; QA can inspect a prioritized report; a product owner can understand affected business capabilities; a release owner can review outstanding uncertainty. Optional verification tools consume the same result to select tests or generate reviewable scripts.

"All languages" is an architectural ambition, not an immediate support claim. Parsing a language, resolving its dependencies, and understanding a framework are three different achievements. Publish a capability matrix instead of a blanket compatibility promise.

### 2.4 Initial marketable scope

Deliver an accurate, evidence-backed analyzer for a bounded TypeScript/JavaScript web stack first. Its first useful paid workflow should work with a CLI/CI report and human review, even if a customer has few automated tests. Add a dashboard to improve collaboration and history, not to conceal weak analysis.

### 2.5 Non-goals

- Proving that an arbitrary program is correct, secure, or free of regression.
- Fully resolving reflection, runtime dependency injection, generated code, or distributed behavior without sufficient evidence.
- Replacing code review, static security analysis, observability, or all regression tests.
- Allowing an LLM to invent dependency edges or decide that a release is safe.
- Executing customer code, browser scripts, or production actions as part of ordinary static analysis.
- Building a graph database, vector database, Kubernetes platform, or autonomous browser agent before a measured need exists.
- Generating Playwright tests from a function name alone, without a reachable surface and a valid expected outcome.

## 3. Users and Personas

### 3.1 Product-user personas

The dashboard should present different views of one analysis, not separate inconsistent analyses for each role.

| Persona | Main question | Primary view | Permitted actions, subject to RBAC |
|---|---|---|---|
| Developer | What else might my change affect? | Changed entities, dependency paths, source evidence, diagnostics | Run analysis, investigate, suggest mappings, comment |
| QA engineer | What should I verify and why? | Ranked behaviors, boundaries, candidate tests, gaps | Review findings, create checklists, propose scenarios |
| QA lead | Is our verification scope defensible? | Coverage gaps, critical areas, review status | Approve scope, assign checks, record dispositions |
| Engineering lead | What risk and uncertainty remain? | Supported scope, critical findings, trends | Set repository policy, review exceptions |
| Product or business owner | Which customer capabilities changed? | Approved business names, affected journeys, unresolved expectations | Clarify intended behavior and business criticality |
| Release owner | What was reviewed and verified for this version? | Version-bound analysis and separately linked verification | Record release disposition under organizational policy |
| Workspace administrator | Who can access source and trigger work? | Membership, repository access, retention, model policy | Manage access and settings, audit activity |

A selected dashboard persona is a display preference, not an authorization mechanism. The backend must enforce permissions independently.

### 3.2 Application-user personas

There is a second meaning of persona: the users of the application being analyzed, such as customer, seller, guardian, support agent, or administrator.

Store these as repository/workspace application-context objects with stable IDs and approved journey associations. Do not infer permissions or business roles solely from names. A route used by two personas can have different authorization rules, data scopes, and expected outcomes.

An impact report may say "guardian access may require verification" only when a supported path or approved mapping justifies that association. Unknown persona coverage must remain unknown.

### 3.3 Core user stories

- As a developer, I can compare two immutable revisions and inspect why a caller is included.
- As QA, I can distinguish directly changed behavior from indirect dependency exposure.
- As QA, I can see unsupported changes even when no known surface is found.
- As a business owner, I can attach approved meaning to a journey without altering compiler facts.
- As a release owner, I can tell whether results belong to the current PR revision.
- As an administrator, I can disable external AI and still obtain a deterministic report.
- As a verification engineer, I can consume structured evidence without scraping human prose.

## 4. How the Current Analyzer Works

This section describes the implementation at the recorded baseline, not the target architecture.

### 4.1 Repository map

| File | Current responsibility |
|---|---|
| [`src/index.ts`](../src/index.ts) | CLI orchestration, file discovery, TypeScript program, graph extraction, Git comparison, changed-function matching, impact traversal, context persistence, output |
| [`src/cli.ts`](../src/cli.ts) | Argument parsing and validation |
| [`src/change-evidence.ts`](../src/change-evidence.ts) | Unified-diff parsing, base-version function ranges, function-scoped evidence extraction |
| [`src/qa-evidence.ts`](../src/qa-evidence.ts) | Test-role heuristic, context selection, unified evidence payload, QA prompt |
| [`src/llm-client.ts`](../src/llm-client.ts) | OpenRouter requests through the OpenAI SDK, report validation, retries, formatting, tracing |
| [`test/`](../test/) | Helper-level change-evidence, QA-evidence, CLI, and mocked LLM tests |
| [`package.json`](../package.json) | Scripts and dependencies |

`src/index.ts` is a side-effectful CLI entrypoint, not an import-safe analyzer library. Graph extraction occurs before its asynchronous `run()` workflow. This is an important first refactoring boundary.

### 4.2 Actual pipeline

```text
CLI arguments and environment
        |
        v
Working-tree TypeScript file discovery
        |
        v
TypeScript Program + TypeChecker
        |
        v
Named function declarations + symbol-resolved CALLS edges
        |
        v
Write technical-graph.json
        |
        v
Git base/head diff + base-file function ranges
        |
        v
Function-scoped changes; exit early if none match
        |
        v
Load or generate application-context.json
        |
        v
Reverse caller traversal, maximum depth 6
        |
        v
One combined QA evidence payload
        |
        v
LLM report + structural and lightweight semantic validation
        |
        v
Console report + analysis.json + optional Markdown
```

### 4.3 Inputs and configuration

Current commands:

```sh
npm run analyze -- /absolute/path/to/repository
npm run analyze -- --target /absolute/path/to/repository --base HEAD~1 --head HEAD --report /tmp/graphentra-report.md
npm run build
node dist/index.js --target /absolute/path/to/repository --base HEAD~1 --head HEAD --report /tmp/graphentra-report.md
npm test
npm run typecheck
```

Supported CLI options are a positional target or `--target`, `--base`, `--head`, and `--report`. Equals syntax is accepted. CLI base and head must be supplied together. Paths are resolved relative to the invoking working directory.

`BASE_SHA` and `HEAD_SHA` can provide the comparison when explicit CLI refs are absent. Otherwise the fallback is `HEAD~1` and `HEAD`. This is a direct two-revision comparison, not an automatic PR merge-base comparison. An initial commit or missing local history can make the fallback fail.

The LLM uses `OPENROUTER_API_KEY` and optional `OPENROUTER_MODEL`. `OPENAI_LOG` controls SDK logging. Dotenv reads `.env` and `../.env` relative to the invocation directory. Do not treat the current default model identifier as a long-term product contract.

There is no implemented analyzer configuration file, offline-report option, installed package `bin`, configurable traversal depth, or general include/exclude interface.

### 4.4 Source discovery and compiler setup

The filesystem walk collects `.ts`, `.tsx`, `.mts`, and `.cts`. It excludes TypeScript declaration files and fixed directory names including `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`, and `.graphentra`. A nested checkout of this analyzer is excluded from a different target application.

This is not a Git-tracked-file inventory. Other ignored or untracked files can be included; test files are included. Symlinks are not followed through the ordinary file/directory branches.

The analyzer reads available `tsconfig.json` compiler options and builds a TypeScript `Program` with a `TypeChecker`. It supplies fallback options when needed. Discovered files, rather than the parsed config's full project/file selection, define the root input set. Project references and compiler diagnostics are not yet a complete monorepo/completeness system.

**Critical restriction:** source entities and dependency edges come from the working tree, while the diff comes from Git refs. Users must currently provide a clean checkout matching the requested head. The program does not enforce that alignment. Recorded `headSha` is checkout `HEAD`, which may differ from an explicitly requested comparison head.

### 4.5 Entity extraction

The first AST pass registers nodes satisfying `ts.isFunctionDeclaration(node) && node.name`.

Each entity contains:

```text
id        = relative/file/path.ts#functionName
kind      = function
name      = declared function name
file      = repository-relative path
startLine = one-based inclusive start
endLine   = one-based inclusive end
```

Named exported and async declarations can be included. The recursive traversal can also register nested named declarations; "standalone" should not be interpreted as an enforced top-level-only rule.

Arrow functions, function expressions, class/object methods, constructors, and anonymous default-export functions are not modeled as entities. Classes, modules, types, constants, APIs, routes, and components are not distinct entity kinds.

An ID based on file and name is not a durable cross-revision identity and can collide across scopes or overloads. This must be fixed before broadening syntax coverage.

### 4.6 Dependency extraction

The second AST pass inspects `CallExpression` nodes. It resolves the callee symbol, follows TypeScript alias symbols, locates the nearest enclosing named function declaration, and adds an edge when both symbols map to known entities.

Stored edge direction:

```text
caller --CALLS--> callee
```

Repeated calls between the same pair are deduplicated. Current edges do not retain individual call-site locations or rich provenance.

This is stronger than matching strings: supported imported functions can resolve across files. However, it is not whole-program runtime analysis. It does not model arbitrary function-value flow, reflection, callback dispatch, framework invocation, or dependency injection.

Top-level calls have no supported caller. Calls inside unsupported callback forms nested in a named declaration can be attributed to that outer declaration. Passing a function to an HTTP router or array operation does not itself establish that the callback is invoked.

TSX parsing is not React support. JSX rendering does not become a `CALLS` edge. A named component or handler may be discovered as an ordinary function without establishing a page, endpoint, or user journey.

### 4.7 Diff parsing and change ownership

The analyzer obtains a Git patch for the chosen revisions, restricted to the target path. `parseGitDiff()` preserves per-file hunks, old/new coordinates, additions, removals, and unchanged context.

For each file with current function entities, it reads the base-version source with Git and extracts old named-function ranges. A current function is matched to its old range by name only when there is one unambiguous candidate in the old file.

`extractEntityChange()` then:

1. Assigns additions using the current function's line range.
2. Assigns removals using the matched base function's line range.
3. Includes unchanged context only when it belongs to the function on both sides.
4. Reconstructs a clipped patch that does not contain neighboring function edits or a misleading Git function heading.
5. Reports changed lines in new-file coordinates; deletion-only changes use an anchor inside the surviving function.

This matters when two functions share a diff hunk or earlier insertions shift later line numbers. File-wide evidence is retained for diagnostics, but each changed function gets its own evidence in the unified report request.

This is AST-assisted line attribution, not semantic AST differencing. Comments or formatting within function ranges can trigger changes. Module-level imports, constants, and configuration may not match any supported entity.

Deleted functions have no current entity and are not impact seeds. Base source is used only to assign removals, not to build a historical graph. Renamed or ambiguous functions may lack removed-code evidence. Overlapping function ranges, including nested declarations or functions on the same line, are skipped with a warning. Pure rename/mode-only patches without normal file headers are not a complete change inventory.

### 4.8 Reverse impact traversal

The analyzer builds an incoming-edge index. Starting at each changed function, it traverses callers in reverse using a breadth-first queue, preserving alternative simple paths up to six edges. A per-path visited set prevents cycles within that path.

Example of the stored graph:

```text
submitOrder --CALLS--> validateCart --CALLS--> checkInventory
```

If `checkInventory` changes, the reported reverse path is:

```text
checkInventory -> validateCart -> submitOrder
```

The impact object contains direct dependents, unique reached entities, path evidence, and terminal dependents. The affected-entity count excludes the changed seed. A terminal dependent has no incoming caller in this discovered graph; it is not necessarily a route or production entrypoint. A node at the depth limit is not automatically terminal.

Multiple paths can grow rapidly in a branching graph. There is currently no total path/work budget or explicit exhausted-frontier record. A static path means potential dependency exposure, not proof that the changed branch executes or that a behavior is broken.

### 4.9 Application context and report generation

If `.graphentra/application-context.json` exists, the analyzer validates and uses it. Otherwise it asks the LLM to generate context containing application meaning, domains, terminology, entity annotations, facts, and unknowns.

**Privacy boundary:** first-time context generation currently sends the full discovered TypeScript source and technical graph to the configured external provider. It has no source/token budget, secret-redaction pipeline, or automatic freshness tracking. This prototype behavior is not an acceptable default for an unreviewed private-repository rollout.

For the QA report, `selectRelevantApplicationContext()` selects annotations for changed/reached entities, associated domain names, and terminology matched against the selected meanings and diffs. It omits unscoped summaries, facts, and unknowns from the QA request. Existing context may still be stale.

`buildLLMPayload()` sends all changed functions in one combined logical report request, retaining isolated evidence and retrieved caller paths. It does not send the entire technical graph for this reporting step.

Filename conventions classify entities as `test` or `production`. Test callers remain in the graph and are separated in the payload. This is not test discovery or measured coverage. The default `production` role is not evidence that a function is user-facing.

The current report contract is:

| Field | Shape |
|---|---|
| `summary` | One string; prompt requests one sentence |
| `keyChanges` | One to five strings |
| `qaChecks` | One to five strings |
| `uncertainty` | Zero or one string |

The OpenAI Node SDK sends requests through OpenRouter. JSON/schema validation and lightweight semantic checks reject malformed or improperly formatted reports. One semantic correction is allowed; invalid JSON or schema failures fail immediately. Selected raw transport failures have bounded retries, separate from SDK retry behavior.

These checks do not prove factual correctness or exact natural-language sentence counts. One logical report operation can cause additional provider calls for correction/retries, and initial context generation is a separate operation.

### 4.10 Outputs and exit behavior

| Output | Current lifecycle |
|---|---|
| `.graphentra/technical-graph.json` | Graph schema `1.0`; rebuilt from discovered source and written before change analysis |
| `.graphentra/application-context.json` | Context schema `1.0`; generated if missing, otherwise loaded; intended to persist |
| `.graphentra/analysis.json` | Analysis schema `1.1`; changed files/entities, impacts, one `qaReport`, limitations; written after successful LLM reporting |
| Optional `--report` path | Human-readable Markdown report or short early-exit message |
| Console | Diagnostics, changed code, LLM traces, and human-readable report |

No-change or unsupported-only changes can exit before loading context or requiring an API key. There is no first-class completed deterministic-only analysis artifact. Failures and early exits can leave an older `analysis.json` beside a newer graph. Consumers must not assume that artifact existence proves a successful current run.

Persistence is filesystem-only. There is no API service, database, job queue, dashboard, automatic CI persistence, Playwright dependency, or browser executor in this repository.

### 4.11 Current tests and limitations

The existing tests cover argument parsing, patch ownership across difficult line shifts, isolated unified payloads, filename roles, and mocked LLM validation/retry behavior. They do not establish graph extraction accuracy, end-to-end CLI correctness, framework mapping, or live report factuality.

The most important gaps to close are revision alignment, explicit unsupported scope, deleted-entity analysis, stable identities, graph/integration fixtures, LLM-independent output, and source privacy. Expanding languages without fixing these would multiply the same weaknesses.

## 5. Requirements and Acceptance Criteria

The following are target requirements. Priorities indicate delivery order, not present implementation.

### 5.1 Functional requirements

| ID | Requirement | Priority | Acceptance evidence |
|---|---|---|---|
| A-01 | Analyze immutable base and target revisions with an explicit comparison mode | P0 | Reproducible output for the same revisions/config; mismatched checkout cannot silently pass |
| A-02 | Produce a result for no-change, unsupported-only, partial, and failed runs | P0 | Integration fixtures verify status, diagnostics, and absence of stale-success ambiguity |
| A-03 | Separate deterministic analysis from optional AI narration | P0 | Full machine-readable evidence without provider credentials; AI failure preserves evidence |
| A-04 | Account for every changed path, including unsupported and deleted files | P0 | Changed-path inventory reconciles with Git; exclusions carry reasons |
| A-05 | Preserve exact before/after evidence and coordinate systems | P0 | Golden tests for shifted hunks, deletion, rename, Unicode, and mixed line endings |
| A-06 | Analyze supported entities and dependency edges on both revisions | P1 | Deleted caller/callee and moved-entity fixtures retain historical evidence |
| A-07 | Support methods, arrow functions, function expressions, and module-level dependencies in TS/JS | P1 | Capability-specific extraction and resolution fixtures pass |
| A-08 | Model framework surfaces through explicit versioned adapters | P1 | Route/component mapping positives and negatives; unsupported conventions reported |
| A-09 | Return bounded, explainable impact paths and truncation frontiers | P1 | Cyclic/high-fanout fixtures terminate within budgets and expose omitted scope |
| A-10 | Rank attention using transparent rules and approved criticality | P1 | Same inputs yield same ranking; every factor is inspectable |
| A-11 | Maintain reviewed business/persona mappings with provenance and freshness | P1 | Stale mappings visible; AI suggestions cannot become approved facts silently |
| A-12 | Export versioned manifests consumable by CLI, API, dashboard, and test planners | P1 | Schema validation and consumer contract fixtures |
| A-13 | Add additional languages through a documented adapter boundary | P2 | A second language integrates without language-specific logic in the impact engine |
| A-14 | Link cross-service effects only through supported contract evidence | P2 | Producer/consumer fixtures retain both service revisions and unresolved cases |
| A-15 | Suggest existing tests and structured verification scenarios | P2 | Every suggestion references findings; selection is not presented as executed coverage |
| A-16 | Support incremental reuse without changing analysis semantics | P2 | Cached and uncached deterministic outputs match |

### 5.2 Non-functional requirements

| Area | Requirement |
|---|---|
| Correctness | Prefer explicit partial results to unjustified certainty; do not silently omit unsupported changed scope. |
| Reproducibility | Bind evidence to source revisions, dependency/build inputs where relevant, tool versions, configuration, and context version. |
| Explainability | Every finding can be traced to source evidence, relation provenance, or an explicitly approved manual mapping. |
| Performance | Bound CPU, memory, files, edges, paths, payload size, and wall time; report truncation rather than hanging. |
| Security | Treat source, manifests, comments, generated tests, and repository configuration as untrusted inputs. |
| Privacy | Minimize retained/transmitted source; external AI is opt-in under a workspace/repository policy. |
| Availability | Deterministic evidence remains useful during AI or dashboard outages. |
| Portability | Local CLI and hosted workers share the same analysis core and artifact contract. |
| Compatibility | Version schemas and adapters; support migrations only for persisted/shipped contracts with real consumers. |
| Observability | Measure stage durations, failures, completeness, adapter coverage, and provider cost without logging secrets. |
| Accessibility | Dashboard reports are keyboard accessible and readable without relying on graph visualization or color alone. |

### 5.3 Definition of a supported capability

A capability is supported only when it has documented syntax/framework boundaries, maintained positive and negative fixtures, an owner, known limitations, diagnostic behavior, and evaluated results. A parser successfully reading a file is not sufficient.

## 6. Target Analyzer Architecture

### 6.1 Separate facts, inference, and execution

```text
CLI / CI / API request
        |
        v
Revision resolver and secure source provider
        |
        v
Workspace inventory and capability detection
        |
        +---------------------+
        v                     v
Base snapshot             Target snapshot
Language adapters         Language adapters
Framework adapters        Framework adapters
        |                     |
        +----------+----------+
                   v
         Entity matching + change classification
                   |
                   v
         Typed impact traversal + completeness
                   |
                   v
         Surface, journey, persona, test mapping
                   |
                   v
         Deterministic ImpactManifest
                   |
        +----------+-----------+
        v                      v
Optional AI narrative     CLI / API / dashboard
        |
        v
Reviewable scenarios -> separate test generation/execution system
```

The analysis core must not depend on HTTP, React, a database, or an LLM provider. Those are adapters around the same deterministic service.

### 6.2 Logical modules

| Module | Responsibility | Must not do |
|---|---|---|
| Source provider | Resolve refs, enumerate tracked paths, retrieve immutable source | Execute repository hooks or build scripts implicitly |
| Workspace detector | Identify projects, languages, configuration, frameworks, unsupported files | Equate dependency presence with framework support |
| Language adapter | Extract entities, references, semantic edges, diagnostics | Invent runtime relationships |
| Framework adapter | Interpret registrations, conventions, routes, templates, DI within declared scope | Hide unsupported configuration |
| Snapshot builder | Normalize and validate graph facts with provenance | Mix revisions without labeling |
| Change engine | Match entities and classify before/after differences | Treat all text differences as proven behavioral differences |
| Impact engine | Traverse appropriate relations, retain reasons and budgets | Delegate graph truth to an LLM |
| Context mapper | Attach approved business meaning and suggested mappings | Override source facts |
| Report builder | Produce manifest, deterministic summary, optional narrative | Execute checks or approve releases |
| Storage/API adapters | Persist, authorize, deliver, and track jobs | Reimplement analysis rules per consumer |

Start with modest modules in the existing repository. Extract only real responsibilities needed for testing and a second consumer. A monorepo or plugin marketplace is not required for the first refactor.

### 6.3 Revision and source handling

Support explicit modes eventually: direct base-to-target comparison, PR merge-base comparison, and an explicitly labeled local working-copy analysis. The initial reliable implementation can support only immutable revision pairs and add the other modes later.

Resolve moving refs to commit IDs before work begins. Record requested refs separately from resolved revisions. Obtain both source snapshots from Git objects or isolated read-only checkouts; never analyze arbitrary disk content under a different target label.

For shallow clones or missing objects, return an actionable error or fetch only under an explicit source-access policy. Treat empty-tree comparisons for initial commits as an explicit case. Define submodule/LFS behavior and report unavailable contents.

Inventory changed paths independently of language parsing so unsupported files cannot vanish. Record ignored generated/vendor files, configuration changes, binary changes, submodules, deletions, and renames as classified inventory entries.

## 7. Multi-Language and Framework Strategy

### 7.1 Support levels

| Level | Capability | Valid product claim |
|---|---|---|
| L0: Inventory | Recognize files and changed paths | We detected changes but cannot map semantic impact here. |
| L1: Syntax | Parse supported entities and local changes | We can identify changed declarations, with limited dependency resolution. |
| L2: Semantics | Resolve supported symbols and typed dependency edges | We can trace supported code dependencies. |
| L3: Framework | Map framework conventions to surfaces | We can connect supported code paths to specific routes/components/jobs. |
| L4: Evaluated workflow | Validate surface/journey mapping against a maintained corpus | We support the documented workflow under published limitations. |

Levels apply per capability and framework version, not automatically to an entire language. The current TypeScript prototype has selected semantic-call capabilities but does not meet a broad L2 language-support claim.

### 7.2 Adapter contract

A language adapter should accept an immutable workspace snapshot, resolved configuration, and budgets. It should return entities, relationships, unresolved references, source evidence, diagnostics, and a capability declaration. Do not leak compiler-specific objects into the shared manifest.

Required adapter metadata includes adapter ID/version, language versions, supported file extensions, entity/relation kinds, required build metadata, limitations, and extraction mode. Native tools may run out of process using versioned JSON messages; TypeScript orchestration does not require rewriting every compiler frontend in JavaScript.

An adapter's first implementation should support full extraction. Add incremental methods only when correctness and invalidation are proven.

### 7.3 Recommended expansion order

Order after the initial TS/JS stack is a customer-demand hypothesis, not a fixed release promise.

| Wave | Language/ecosystem | Candidate analysis technology | First useful scope and major caveat |
|---|---|---|---|
| 1 | TypeScript and JavaScript | Retain TypeScript Compiler API | Methods, arrows, modules, imports, type dependencies; JS inference is less certain |
| 1 | React plus one routing/backend stack | TS semantic facts plus dedicated adapters | JSX render dependencies and bounded route registration; not every convention at once |
| 2 | Python | Python AST plus evaluated symbol/import tooling; Tree-sitter where useful | Functions/classes/imports, then one of FastAPI or Django; dynamic dispatch remains partial |
| 2 | Java | Evaluate Eclipse JDT or a Java parser with symbol resolution in a worker | Methods/types, then bounded Spring controller/DI support; build classpath matters |
| 2 | C# | Evaluate Roslyn in a .NET worker | Symbols, methods, types, then ASP.NET mappings; project/build configuration matters |
| 3 | Go | Evaluate `go/packages`, `go/types`, and SSA tooling | Packages/functions/interfaces, then selected HTTP frameworks; dispatch approximation explicit |
| 3 | PHP and Ruby | Native/parser ecosystems plus Tree-sitter candidates | Laravel/Rails conventions only after framework-specific evaluation |
| 3 | Rust | Tree-sitter syntax; evaluate rust-analyzer-derived semantic integration | Traits/macros/build features require specialized handling |
| 3 | C and C++ | Evaluate Clang tooling with compilation database | Preprocessor/build variants and indirect calls require declared scope |
| Later | Kotlin, Swift, other ecosystems | Native compiler/parser integrations where practical | Prioritize only with a customer use case, fixtures, and maintenance owner |

These are technology candidates, not already integrated dependencies. Run small comparative spikes before selecting native tooling or pinning versions.

### 7.4 Why not one universal parser?

Tree-sitter is useful for multi-language concrete syntax trees and incremental parsing. It does not by itself provide a type checker, build-system model, symbol-resolution engine, or framework understanding.

Use syntax-only extraction where useful, but label its resolution strength. Prefer native semantic tooling for ecosystems where it materially improves correctness. A normalized intermediate graph combines outputs without pretending all adapters have equal precision.

### 7.5 Framework adapter roadmap

| Framework family | Evidence to model | Explicit hard cases |
|---|---|---|
| React | Components, JSX render use, hooks, props, supported event bindings | HOCs, dynamic component selection, context/state flow |
| Next.js | Supported file routes, layouts, route handlers, server/client boundaries | Version-specific conventions, middleware, rewrites, generated routes |
| Express/Fastify | Registered method/path, middleware order, handlers, schemas | Dynamic router factories, computed prefixes, runtime registration |
| NestJS/Angular | Supported decorators, controllers/components, provider wiring | Runtime modules, DI tokens, dynamic configuration |
| Vue/Svelte | Script/template dependencies, components, supported routing/state | Compiler transforms and plugin-dependent behavior |
| FastAPI/Django | Route/controller/view bindings, schemas, supported ORM use | Dynamic imports, decorators, settings-dependent routing |
| Spring/ASP.NET | Controller endpoints, services, DI, supported contracts | Reflection, proxies, profiles, generated bindings |
| Rails/Laravel | Routes, controllers, models, approved convention rules | Metaprogramming, plugins, implicit behavior |

For the first framework milestone, select one real pilot application and support its smallest useful vertical slice. For example, React plus Express may be simpler than promising React, Next.js, NestJS, and every router simultaneously.

### 7.6 Cross-language and cross-service impact

Use explicit boundary evidence: OpenAPI operations, GraphQL operations/schema fields, protobuf/RPC methods, generated client metadata, event schemas, service manifests, and approved service mappings.

A frontend request and backend route with similar strings are not automatically a proven connection. Preserve origin, method, version, deployment environment, and confidence. Dynamic URLs and ambiguous consumers produce unresolved-boundary findings.

For multiple repositories, bind each service snapshot to its own revision and dependency/deployment manifest. Do not assume another service's default branch is the deployed consumer version.

## 8. Graph, Change, and Impact Algorithms

### 8.1 Shared evidence model

Proposed entity kinds include modules, functions, methods, constructors, classes, interfaces/types, variables/constants, components, hooks, routes/endpoints, schemas, data models, jobs, events, configuration keys, and tests. Add kinds only with extraction rules and propagation semantics.

Each entity should have a snapshot-local ID, language, kind, qualified name, repository/project identity, source span, declaration/signature fingerprint, source role, adapter provenance, and relevant diagnostics.

Use revision-qualified entity IDs for unambiguous evidence. Store cross-revision correspondence separately; do not promise one immortal ID that survives arbitrary moves, splits, and renames.

Source spans must declare coordinate conventions. Recommended normalized display coordinates are one-based lines with zero-based, end-exclusive UTF-16 columns; adapters must explicitly convert byte/code-point offsets or retain a declared native offset representation. Test non-ASCII input rather than assuming all parsers use the same offsets.

### 8.2 Relationship vocabulary and direction

Where practical, orient dependency relationships from consumer to provider. This makes reverse traversal from a changed provider coherent. Relation-specific rules still determine whether and how propagation is valid.

| Relation | Direction | Meaning and caution |
|---|---|---|
| `CALLS` | Caller -> callee | Supported static call target; not proof of execution |
| `IMPORTS` | Importer -> imported module | Coarse dependency; not all exports are necessarily used |
| `REFERENCES` | Consumer -> symbol | Supported symbol use with reference kind |
| `USES_TYPE` | Declaration/consumer -> type | Relevant to type/contract changes, not always runtime behavior |
| `EXTENDS` / `IMPLEMENTS` | Derived type -> base/contract | Propagation depends on changed members and dispatch rules |
| `RENDERS` | Parent component -> child component | Supported render dependency |
| `HANDLED_BY` | Endpoint/event/job -> handler | Framework registration evidence |
| `REQUESTS` | Client operation -> endpoint/contract | Only when a boundary adapter resolves the target |
| `READS` / `WRITES` | Operation -> data/config entity | Access dependency; does not imply all readers observe all writes |
| `CONSUMES_EVENT` | Handler -> event contract | Subscription/consumer evidence |
| `PRODUCES_EVENT` | Producer -> event contract | Declaration of production; flow rules must distinguish producers and consumers |
| `TESTS` | Test -> target/surface | Mapping evidence, with source such as annotation or observed coverage |
| `BELONGS_TO` | Entity -> owner/module | Structural containment; not an automatic behavioral propagation edge |

Edges must carry source locations, extractor/rule version, evidence kind, resolution strength, and revision. Runtime observations and human mappings are distinct provenance categories, not rewritten as compiler facts.

Avoid blindly traversing every relation in both directions. Data writes and event production may require a deliberate forward step to a contract/data node followed by reverse traversal to consumers. Those transitions need tested rules.

### 8.3 Before/after matching

1. Build normalized base and target snapshots independently.
2. Match clear identities by project, qualified scope, kind, and declaration characteristics.
3. Use Git rename information and fingerprints as evidence for moves/renames, not certainty.
4. Record match strength and ambiguity. Do not collapse a possible split/merge into one invented correspondence.
5. Treat unmatched base entities as removed and unmatched target entities as added.
6. Preserve ambiguous matches as explicit uncertainty and conservatively retain relevant evidence from both sides.

Stable sorting and canonical serialization should make deterministic evidence reproducible. Exclude timestamps, run IDs, and optional AI wording when comparing semantic output hashes.

### 8.4 Change taxonomy

| Change kind | Example | Expected analysis treatment |
|---|---|---|
| Addition/removal | New function or deleted endpoint | Seed the relevant snapshot; preserve removed-consumer evidence |
| Body/logic | Comparison threshold, branch, calculation | Analyze dependency exposure; describe observable change only if supported |
| Signature | Parameter, return type, visibility | Inspect callers and contract compatibility |
| Type/schema | Optional field becomes required | Traverse type/contract consumers with compatibility rules |
| State/data access | Different field written or storage key used | Use supported read/write rules and note runtime conditions |
| Framework wiring | Middleware, route, provider registration | Analyze surface/registration changes, not just handler bodies |
| Configuration/dependency | Feature flag, package version, compiler option | Reassess affected scope; escalate when semantic analysis is unavailable |
| Rename/move | Function relocates without clear logic change | Preserve correspondence and consumer changes; avoid assuming equivalence |
| Documentation/format | Whitespace or ordinary comment edits | Lower attention only when adapter can distinguish semantic directives |
| Unknown | Parse failure, unsupported DSL, generated transform | Explicit unknown scope; never silently discard |

Normalized AST fingerprints can identify many non-structural edits, but cannot generally prove semantic equivalence. Comments can contain framework directives; strings can be contracts. Optimizations that suppress findings must be backed by fixtures.

### 8.5 Base and target impact

Traverse changed/removed entities in the base graph and changed/added entities in the target graph. Group results through recorded entity correspondence, while preserving each path's revision.

Do not stitch half of a base path to half of a target path and present it as a real dependency chain. A removed API with removed callers has historical impact evidence; whether it is an intended retirement is a separate product/review question.

If one graph cannot be built, return partial evidence with the missing side identified. Do not label the combined result complete.

### 8.6 Bounded traversal and explainability

Use a visited-node set for reachability and a bounded predecessor/path structure for explanations. Avoid enumerating every simple path as the only way to determine affected entities. Handle strongly connected components explicitly where useful for large cycles.

Maintain configurable limits for depth, visited entities, edges, paths per finding, total path evidence, payload bytes, memory, and time. Retain a small deterministic set of useful witness paths per finding. Preserve an inspectable frontier when a budget stops traversal.

Separate impact completeness from presentation limits. Showing three representative paths does not mean only three paths exist; limiting traversal itself creates an analysis gap. Shared utility hubs should be grouped for readability, not dropped to make a report look precise.

### 8.7 Surface and journey mapping

A surface is an endpoint, screen, command, job, event consumer, or other supported observable entrypoint. A journey is a sequence or business capability that may span surfaces. A persona is associated through approved mappings or supported authorization/context evidence.

Prefer framework facts for code-to-surface mapping. Use approved context for surface-to-business meaning. Keep inferred suggestions separate until reviewed. Do not reinterpret a graph leaf as a user journey.

### 8.8 Priority, confidence, and uncertainty

Keep three independent dimensions:

- **Attention priority:** How important it is to inspect or verify this area, using approved business criticality, change kind, exposed contract, dependency proximity, and verification gaps.
- **Evidence confidence:** How strongly the supported relationships establish the connection, with rule-level reasons rather than an uncalibrated probability.
- **Completeness:** What scope was not analyzed, including dynamic dispatch, unsupported syntax, missing dependencies, and truncated traversal.

Begin with inspectable rule-based priority bands such as critical/high/normal/informational. Treat them as attention categories, not defect severity. A low-confidence potential authentication impact may warrant high attention. Never multiply low confidence into a low priority that hides consequential unknowns.

Do not publish a numeric failure probability until calibrated against an appropriate labeled dataset.

## 9. Application Context and AI

### 9.1 Three evidence layers

| Layer | Authority | Examples |
|---|---|---|
| Deterministic evidence | Source extraction and supported rules | Exact diff, call edge, registered route |
| Approved context | Named human or approved imported source | Business criticality, journey ownership, persona mapping |
| AI interpretation | Advisory and reviewable | Plain-language synthesis, suggested labels, candidate verification scenarios |

Store these layers separately. An LLM may explain facts and propose mappings, but it must not modify deterministic graph facts or silently promote its guesses to approved context.

### 9.2 Context lifecycle

Replace one unversioned semantic file with a versioned context contract when consumers need it. Each mapping should record subject ID, meaning, provenance, author/reviewer, approval state, revision/fingerprint applicability, last review, and invalidation reason.

Invalidate or flag mappings when their subject disappears, changes identity ambiguously, changes materially, or crosses an unsupported framework boundary. Retain historical context for old analyses rather than rewriting their meaning retroactively.

Manual onboarding should ask for important capabilities, critical journeys, application personas, ownership, and known external services. This can provide value without uploading full source to a model.

### 9.3 Proposed AI workflow

1. Complete and persist deterministic evidence first.
2. Select only relevant evidence and approved context under explicit byte/token limits.
3. Redact disallowed source and potential secrets before provider egress.
4. Send evidence as untrusted data under a fixed system policy.
5. Require structured claims with evidence references and unresolved questions.
6. Validate shape and reference integrity; reject references that do not exist.
7. Evaluate factual grounding with offline human-reviewed fixtures; schema validation alone is insufficient.
8. Save provider/model/prompt versions, usage, outcome, and evidence hash separately from graph truth.
9. On failure, show the deterministic report with narration unavailable.

Narrative should preserve numeric boundaries and distinguish actual implementation changes from intended behavior. The diff is not automatically a valid test oracle: a new behavior may itself be wrong. Expected outcomes for generated verification should come from approved requirements, contracts, existing tests, or reviewed interpretation.

### 9.4 Provider strategy

Keep the present OpenRouter integration behind a narrow provider interface when a second provider or local model is needed. Support workspace opt-out and deterministic-only operation first. Do not build a general autonomous-agent framework for simple report generation.

Record total attempts and end-to-end budgets across SDK retries, transport recovery, semantic correction, and context generation. A small logical request count must not hide unbounded cost or latency.

## 10. Output Contracts and Reporting

### 10.1 Proposed `ImpactManifest`

The current `analysis.json` schema `1.1` is not this future contract. Define the new manifest as its own versioned contract, with a migration/export policy only if existing consumers require one.

| Field group | Required meaning |
|---|---|
| Identity | Schema version, analysis ID, creation time, engine and adapter versions |
| Comparison | Repository IDs, requested refs, resolved base/target, comparison mode, source/config/dependency fingerprints |
| Capabilities | Detected language/framework versions, enabled adapters, supported and unsupported capabilities |
| Scope | Changed-path inventory, analyzed/excluded files, entity/relation counts, exclusion reasons |
| Changes | Before/after entity references, change categories, exact source evidence, match strength |
| Findings | Impacted entity/surface, priority, evidence confidence, related changes, witness paths |
| Context | Context version, approved journey/persona associations, stale or suggested mappings |
| Completeness | Complete-within-declared-scope or partial; structured gaps and traversal frontiers |
| Verification hints | Candidate tests/scenarios, evidence basis, missing expected outcomes; no execution authority |
| Narrative | Optional separately identified report; generation state and evidence references |
| Metrics | Stage durations, workload counts, budgets, cache use, provider usage where allowed |

All referenced entities, edges, evidence objects, and gaps must be present or retrievable through an authorized immutable artifact reference. Never supply dangling IDs and call the result explainable.

### 10.2 State model

Do not compress all states into one green/red badge.

| Dimension | Proposed values |
|---|---|
| Job state | `queued`, `running`, `completed`, `failed`, `cancelled` |
| Evidence completeness | `complete_within_declared_scope`, `partial` |
| Change result | `changes_found`, `no_changes`, `no_supported_changes` |
| Narrative state | `not_requested`, `pending`, `available`, `failed` |
| Human review | `unreviewed`, `accepted`, `dismissed_with_reason`, `needs_clarification` |
| Verification state | Separately linked `not_planned`, `planned`, `running`, `passed`, `failed`, `inconclusive`, `cancelled` |

Completeness is present when usable evidence exists; a failed job may have diagnostic/checkpoint artifacts rather than a completed manifest. `no_supported_changes` must not be rendered as "no impact." Execution `passed` means recorded assertions passed, not that all impacted behavior is correct.

### 10.3 Structured gaps

A gap should identify a code, severity/attention policy, affected paths or entities, reason, stage, and possible remediation. Examples include `UNSUPPORTED_LANGUAGE`, `UNRESOLVED_CALL`, `MISSING_BASE_OBJECT`, `PARSE_ERROR`, `DYNAMIC_ROUTE`, `STALE_CONTEXT`, and `TRAVERSAL_LIMIT`.

Some failures, such as an invalid comparison, should fail the job. Others, such as one unsupported changed file, can allow a partial manifest. Define the distinction in tests, not ad hoc UI logic.

### 10.4 Human report structure

1. Comparison identity, analyzed scope, and completeness banner.
2. Concise summary of supported changed behavior.
3. Prioritized impacted surfaces and approved journeys/personas.
4. Why each is included, with inspectable before/after evidence and dependency paths.
5. Focused verification suggestions and existing-test candidates.
6. Unknowns, unsupported changes, and required clarification.
7. Human review and separately linked version-bound execution results.

Retain the current concise unified narrative as a presentation layer, but do not constrain the full product's uncertainty inventory to one string or hide findings because the summary has five bullets.

## 11. Technology Decisions

These are recommended defaults, not authorization to install all of them now. Pin supported versions at implementation time and verify compatibility against official documentation.

| Concern | Recommended direction | Rationale and adoption trigger |
|---|---|---|
| Core orchestration | Continue TypeScript on a supported Node.js LTS | Reuse current work and team skills; declare runtime support explicitly |
| TS/JS semantics | Continue TypeScript Compiler API | Existing symbol resolution is worth preserving |
| Multi-language syntax | Evaluate Tree-sitter selectively | Broad grammar ecosystem; not a replacement for semantic resolution |
| Other language semantics | Native tooling in isolated workers where justified | Higher fidelity than rebuilding compilers; accept toolchain cost only for supported ecosystems |
| Runtime validation | Keep Zod for existing internal boundaries | Avoid unnecessary rewrite of working validation |
| Public contracts | Versioned JSON Schema and generated/shared types | Language-neutral API/worker integration; test consistency with internal schemas |
| API server | Node.js/TypeScript with Fastify as proposed default | Schema-driven request/response boundaries; same team/runtime as orchestration |
| Database | PostgreSQL | Analysis metadata, tenancy, review history, durable jobs, indexed relationships where needed |
| Graph representation | In-memory adjacency maps plus immutable snapshot artifacts initially | Simpler deployment; profile before adopting specialized graph storage |
| Large artifacts | S3-compatible object storage | Source snapshots if permitted, graph snapshots, manifests, traces with retention policies |
| Queue | PostgreSQL-backed durable jobs initially | One operational datastore; require leases, retries, cancellation, and idempotence |
| Queue at scale | Evaluate managed queue or Redis/BullMQ only when needed | Avoid adding Redis merely because jobs exist |
| Dashboard | React and TypeScript; choose app framework with the dashboard team | Shared contracts and persona views; do not couple analysis to rendering |
| Graph visualization | Optional Cytoscape.js/React Flow evaluation | Evidence list first; add visualization only for a useful investigation workflow |
| Browser verification | Playwright Test for a TS executor | Downstream test generation and execution, not dependency discovery |
| Observability | Structured logs, metrics, OpenTelemetry when deployed | Correlate API jobs, analysis stages, and providers |
| Deployment | Containers and a managed service for API/workers | Reproducible tools and resource limits; orchestration complexity only as needed |
| CI | Repository-native CI, initially GitHub Actions if chosen by the team | Run existing checks plus contract/integration/security gates |

Do not select a vector database for deterministic dependency traversal. Consider semantic retrieval only for a measured context-search problem, with provenance and tenant isolation. Do not adopt Neo4j or another graph database until representative workloads show a real advantage over snapshot adjacency and PostgreSQL metadata.

Current packaging needs review before distribution: package and internal analyzer versions differ, TypeScript is a runtime import currently listed as a development dependency, no package `bin` is declared, and Node compatibility is not explicitly declared. Resolve these as packaging decisions with smoke tests, not incidental feature work.

## 12. Backend, Storage, and APIs

This section defines what is needed to deliver analyzer results to a dashboard. It is not a separate full SaaS implementation specification.

### 12.1 Service shape

Start with a modular API/control-plane service and separate worker processes, not many microservices. The API authenticates users and repository access, accepts work, records immutable requests, and returns job identity. Workers perform isolated analysis and publish artifacts atomically.

The worker reuses the same analysis core as the CLI. Dashboard requests must not launch long synchronous compiler work inside an HTTP request handler.

### 12.2 Minimal persistence model

| Record | Key contents |
|---|---|
| Workspace/member | Tenant identity, user identity, roles, source access policy |
| Repository/installation | Provider repository ID, authorized installation, allowed projects, capability config |
| Analysis job | Request identity, resolved revisions, state, idempotency key, lease, attempt history |
| Snapshot/artifact | Content hash, revision/config identity, object key, size, retention, tenant ownership |
| Finding index | Analysis ID, priority, surface/persona IDs, evidence pointer, searchable summary |
| Context version | Approved mappings, authorship, review status, applicability and invalidation |
| Review event | Actor, finding/context subject, action, reason, timestamp |
| Usage/audit event | Metered work, provider calls, policy changes, artifact access, deletion |

Use composite tenant-scoped constraints and authorization on every read/write. Large graphs and patches belong in immutable artifacts unless measured query needs justify normalized tables. Keep credentials in a secret manager, not source artifacts or arbitrary JSON metadata.

### 12.3 Proposed analysis API

These endpoints do not exist yet.

| Endpoint | Purpose |
|---|---|
| `POST /v1/analyses` | Accept repository ID, base/target refs, comparison mode, approved analysis options; return `202` and analysis ID |
| `GET /v1/analyses/{id}` | Job state, resolved identity, stage, completeness, artifact availability |
| `GET /v1/analyses/{id}/manifest` | Authorized versioned manifest |
| `GET /v1/analyses/{id}/findings` | Paginated/filterable findings from that immutable result |
| `GET /v1/analyses/{id}/evidence/{evidenceId}` | Authorized source/path evidence with revision context |
| `POST /v1/analyses/{id}/cancel` | Request cancellation; do not claim completion until worker acknowledgement |
| `POST /v1/analyses/{id}/reviews` | Append review/disposition without mutating original evidence |
| `GET /v1/repositories/{id}/capabilities` | Detected and supported language/framework capabilities |
| `GET /v1/repositories/{id}/context` | Retrieve permitted approved/suggested mappings |
| `POST /v1/repositories/{id}/context-versions` | Propose a new context version under review policy |

Authentication, installation onboarding, membership management, and context approval need their own contracts before implementation. Do not accept arbitrary host filesystem paths or unrestricted clone URLs through a hosted API.

### 12.4 Request and worker semantics

- Validate bounded inputs and schema versions; resolve repository access before retrieving code.
- Scope idempotency keys to tenant and canonical request payload; same key/different payload is a conflict.
- Deduplicate identical analysis inputs without assuming an AI narrative is byte-for-byte deterministic.
- Treat queue delivery as at least once; workers must safely retry stages and publish only one accepted result per attempt identity.
- Use leases/heartbeats, retry limits, cancellation checks, dead-letter/error inspection, and transactional enqueue or an outbox.
- Upload temporary artifacts first, verify hashes, then atomically publish their database references.
- Separate job failure from a valid partial result. Retain failed-attempt diagnostics under the same privacy policy.
- Support pagination and bounded evidence expansion; never send the full repository graph to every dashboard view.
- Return machine-readable error codes without leaking source, credentials, or internal paths.

### 12.5 Git provider integration

Begin with one provider. For GitHub, a repository-scoped GitHub App is the proposed hosted integration. Verify webhook signatures, deduplicate delivery IDs, resolve PR revisions explicitly, and handle force pushes/out-of-order events.

Mark prior results stale when the PR target changes. A review or verification on an older revision must remain visible as historical evidence, not be presented as current. Fork PRs and untrusted branches must not receive write tokens or provider secrets through ordinary analysis jobs.

Post a short PR summary linking to evidence and support limitations. CI gating should initially be advisory; only use blocking policies for narrowly defined, validated conditions such as an invalid analysis or an explicitly configured unsupported-scope rule.

## 13. Dashboard Integration

### 13.1 Minimum screens

| Screen | Required content |
|---|---|
| Repository onboarding | Access scope, detected stack, supported capabilities, privacy/model policy |
| Analysis list | PR/revision pair, author/time, job state, completeness, stale status |
| Impact report | Unified summary, ranked surfaces, application personas, gaps, verification hints |
| Evidence detail | Before/after source, typed dependency path, provenance, confidence, revision |
| Context review | Suggested and approved journeys/personas, mappings, stale annotations |
| Review/history | Decisions, reasons, actors, linked verification results for exact versions |

### 13.2 Persona-specific presentation

Developer view emphasizes source and graph evidence. QA view emphasizes behaviors, boundaries, and unverified scope. Product view uses approved business terms while retaining access to evidence. Lead/release view emphasizes criticality, unresolved gaps, and version-bound review status.

All views use the same findings and completeness data. Do not regenerate incompatible "truth" with separate persona prompts. A natural-language rewrite must preserve referenced claims.

### 13.3 UX invariants

- Show revision identity, stale status, and unsupported scope before a user makes a decision.
- Prefer a useful ranked list and path explanation over a large default force-directed graph.
- Keep "no supported findings" visually distinct from "no changes" and from "checks passed."
- Show application personas only when their mappings have an evidence/approval basis.
- Display deterministic evidence even when AI narration fails.
- Provide a manual checklist/export path when no automated test exists.
- Ensure desktop/mobile readability and keyboard-accessible evidence inspection.
- Require server-side permission checks even when UI controls are hidden.

## 14. Change-Driven Playwright Generation

This is a future consumer of analyzer output. No Playwright generation or execution is implemented in this repository at the baseline.

### 14.1 Correct product boundary

```text
ImpactManifest
    -> supported surface + approved behavior/expectation
    -> existing test lookup
    -> proposed verification scenario
    -> human/policy review
    -> generated or selected Playwright script
    -> approved execution grant in a separate system
    -> version-bound result and artifacts
```

The analyzer identifies where attention may be needed. A planner decides what to verify. A generator creates candidate code. An executor runs only authorized code in a permitted environment. A person or policy determines disposition.

### 14.2 Required generation inputs

| Input | Why it is required |
|---|---|
| Manifest and finding IDs | Trace generated work back to a specific change and evidence |
| Surface/journey mapping | Know how the behavior is reachable through UI/API |
| Approved expected outcome | Avoid treating the changed implementation as automatically correct |
| Application persona/auth fixture | Exercise the right permissions and data scope |
| Environment/deployment identity | Know which application version will be checked |
| Existing test/page-object conventions | Reuse stable navigation, fixtures, and selectors |
| Selector/DOM evidence | Avoid invented locators; approved inspection is separate from static analysis |
| Synthetic data and cleanup plan | Make execution repeatable and avoid real-user mutations |
| Allowed actions/origins and resource limits | Prevent unauthorized or unbounded execution |

If these inputs are missing, produce a blocked scenario or manual checklist, not a fabricated ready-to-run test.

### 14.3 Generation policy

Prefer selecting or updating an existing approved test before creating another. Generate the smallest scenario that checks the changed boundary plus a justified regression path. Unit/API tests may be more appropriate than browser tests for internal behavior.

Generated Playwright should use established repository fixtures, user-facing locators or explicit test IDs, web-first assertions, controlled data, and bounded timeouts. Avoid arbitrary sleeps, hardcoded credentials, guessed CSS selectors, and unapproved third-party interactions.

Validate syntax, types, conventions, evidence references, and safety policy before execution. Static validation is not a security sandbox. Generated scripts and their dependencies must run with separate credentials and isolation.

### 14.4 Example: changed inventory threshold

Suppose supported diff evidence changes a low-stock threshold from five to ten. The analyzer can describe the literal boundary and trace supported callers. It may identify a stock API or product screen only after the relevant adapters/mappings exist.

If a product owner confirms the new rule and controlled stock fixtures exist, a planner can propose values just below, at, and above the changed boundary, with separately justified zero-stock behavior. A browser generator can then target the supported product screen using known locators. Without a UI mapping, an API/unit check or manual verification note is the correct output.

Do not invent every neighboring branch as a required check, and do not conflate number of records with total quantity of units.

### 14.5 Separate integration contracts

Retain the broader playbook's separation between `ImpactManifest`, `VerificationPlan`, `ExecutionGrant`, and `VerificationResult`. Each references exact immutable inputs. A script is a draft until reviewed; a plan is not permission to execute; a successful process exit is not evidence that required assertions ran.

Results should record script hash, target deployment/revision, environment, assertions, artifacts, retries, outcome, and cleanup state. Browser context isolation alone does not isolate shared databases, queues, email, payments, or external services.

## 15. Security and Privacy

### 15.1 Trust boundaries

Treat repository content as untrusted, including code comments, README instructions, configuration, parser inputs, and generated artifacts. Analysis workers must not obey instructions found in source or pass them to an agent as authority.

Use read-only source access, least-privilege short-lived tokens, filesystem boundaries, process resource limits, and restricted network egress. Resolve paths safely; protect against traversal, symlink escape, oversized files, archive bombs, malicious refs, and command/argument injection. Disable repository hooks and avoid untrusted Git external-diff/filter execution.

Do not run package installation scripts or builds by default. If native semantic tooling needs build/classpath metadata, obtain it through a separately approved restricted step or emit a partial result. Containers are useful packaging but must be hardened; stronger isolation may be required for genuinely untrusted execution.

### 15.2 Data policy

- Document exactly what source, patches, context, and metadata leave the customer's environment.
- Default to deterministic-only analysis until external-model processing is approved.
- Apply secret detection/redaction and file allow/deny policy before egress; acknowledge that automated redaction is not perfect.
- Never log full source, prompts, credentials, or authentication state by default.
- Encrypt data in transit/at rest and use tenant-scoped artifact access with short-lived signed links.
- Define retention separately for source snapshots, manifests, logs, context, and verification artifacts.
- Implement deletion across primary records, object storage, caches, and backup-expiry policy; disclose delayed backup expiry.
- Verify model-provider retention/training/data-region terms for the chosen plan rather than assuming a privacy guarantee.
- Audit repository access, context approvals, permission changes, report downloads, and execution grants.

### 15.3 Prompt injection and generated code

Source and context are data, not instructions. Evidence references must be validated against the deterministic result. A model response must not be able to request additional source access, change policies, invoke shell commands, or authorize execution.

Separate static-analysis, AI-reporting, and execution credentials. Generated Playwright is untrusted code even if it typechecks and looks reasonable.

### 15.4 Deployment options

Begin with local/CI execution and a narrowly scoped hosted control plane. Offer customer-hosted analysis workers or private deployments only when buyers justify their operational/support cost. Avoid claiming regulatory compliance, certification, or guaranteed source secrecy before the relevant controls and contractual review exist.

## 16. Testing, Evaluation, and Quality Gates

### 16.1 Preserve current checks

The existing offline checks are `npm test`, `npm run typecheck`, and `npm run build`. Run them for implementation changes. Mock provider requests in ordinary tests; do not require live credentials or send private source during CI.

### 16.2 Test layers to add

| Layer | Required coverage |
|---|---|
| Pure unit tests | Diff ownership, identity matching, change classification, ranking, context selection |
| Graph fixtures | Aliases, re-exports, shadowing, scopes, overloads, methods, callbacks, cycles, hubs, unresolved symbols |
| Real Git integration | Construct revision pairs and run CLI/core; assert outputs, no-change/failure handling, deletion/rename behavior |
| Snapshot equivalence | Cached and uncached results; deterministic ordering across repeated runs |
| Adapter conformance | Shared contract, source coordinates, provenance, budgets, capability reporting |
| Framework fixtures | Supported registrations/rendering plus dynamic/unsupported counterexamples |
| API/worker contracts | Authorization, idempotency, leases, duplicate delivery, cancellation, stale PR events |
| Security tests | Hostile filenames, prompt injection, redaction, cross-tenant access, malicious configuration |
| AI evaluations | Numeric fidelity, before/after direction, grounded claims, no fabricated surfaces or requirements |
| Performance tests | Cold/warm snapshots, large fanout, cycles, monorepos, memory and provider budgets |
| Downstream contracts | Dashboard references and planner scenarios resolve to actual manifest evidence |

### 16.3 Fixture corpus

Create small maintained applications and real Git histories rather than relying only on hand-written diffs. Each scenario should include base/target revisions, expected changed entities, required impact paths/surfaces, acceptable uncertainty, and negative assertions.

Include deleted functions/files, pure renames, nested/same-line declarations, removed registrations, type-only changes, configuration-only changes, unsupported languages, syntax errors, missing dependencies, initial commits, shallow history, Windows paths, spaces/Unicode, and line-ending differences.

Security/authentication, authorization, payments, and data-isolation examples should be explicitly labeled critical in the fixture policy. These labels are test expectations, not automatically inferred from naming.

### 16.4 Product-quality evaluation

Use a permissioned historical-change dataset with reviewers who know the application. Agree a ground-truth set of relevant surfaces and material unknowns before tuning thresholds. Keep a held-out evaluation set so the tool is not optimized only for demo cases.

Measure surface recall and precision separately. Report scope and denominators: an unsupported surface is not a true negative. Count unsupported critical changes as an end-to-end coverage problem even when in-scope recall is high. Track unknowns and reviewer disagreement rather than forcing false ground truth.

Also measure explanation correctness, critical misses, reviewer usefulness, time to first report, planning time, onboarding effort, stale-context frequency, and cost per useful analysis. Test coverage percentage alone is not an analyzer accuracy metric.

### 16.5 Proposed pilot gates

These are targets to validate, not achieved results or statistical guarantees.

| Gate | Initial target |
|---|---|
| Changed-path accounting | Every changed path classified or explicitly excluded |
| Critical fixture omissions | Zero silent omissions in the maintained critical fixture set |
| Supported-surface quality | Aim for at least 90% recall and 70% precision on a reviewed initial corpus; publish corpus size and limitations |
| Reproducibility | Identical canonical deterministic evidence for the same pinned inputs |
| Unsupported behavior | All maintained unsupported fixtures yield appropriate gaps/partial status |
| Provider outage | Deterministic report available without a successful AI call |
| Privacy | No prohibited source/secrets in provider payloads or routine logs in security fixtures |
| Latency | Provisional warm deterministic p95 under two minutes on a declared pilot workload |
| User value | Demonstrated reduction in planning effort without increased critical omissions |

For performance claims, publish hardware, repository size, file/entity counts, supported stack, change size, cache state, concurrency, and sample count. A provisional benchmark might be one pilot repository of up to 100,000 first-party lines; revise the budget after measurement. Report AI latency separately from deterministic latency.

## 17. Implementation Roadmap

### 17.1 Sequencing principle

Trustworthy output comes before breadth. Broader syntax comes before broad framework claims. Framework surfaces and approved expectations come before automated browser generation. The dashboard can begin against canonical fixtures once the contract stabilizes.

The effort ranges below are provisional engineer-weeks, not delivery dates. They assume familiarity with the code and do not include enterprise compliance or universal language support. Re-estimate after the first integration fixtures and a real pilot repository.

| Milestone | Indicative effort | Main result | Exit gate |
|---|---|---|---|
| M0: Trust foundation | 2-3 engineer-weeks | Import-safe core, immutable comparison, offline evidence, explicit outcomes | Real Git fixtures prove identity and failure/no-change behavior |
| M1: TypeScript/JavaScript coverage | 3-5 engineer-weeks | Base/target graphs, stable scoped identities, wider callable syntax, bounded traversal | Capability suite covers additions/deletions and common callable forms |
| M2: One framework vertical slice | 3-5 engineer-weeks | Supported routes/components mapped to evidence and reviewed context | Historical pilot changes meet agreed surface-quality gate |
| M3: Product integration | 3-5 engineer-weeks across roles | Manifest API, jobs, storage, minimal persona dashboard and PR report | End-to-end authorized change-to-reviewed-report flow |
| M4: Commercial pilot hardening | 2-4 engineer-weeks plus observation | Onboarding, privacy, metrics, feedback, operational recovery | Design partners demonstrate repeatable value and bounded costs |
| M5: Second language | 3-6 engineer-weeks per initial adapter slice | Common model proven beyond TypeScript | Adapter conformance and real customer workflow pass |
| M6: Verification handoff | 2-4 engineer-weeks for analyzer/planner contract; executor estimated separately | Existing-test suggestions and reviewable scenarios | Grounded scenarios with blocked states for missing inputs |

M3 dashboard shell work can overlap M1/M2 using fixtures. M6 contract work can begin earlier, but generated execution must not gate the first analyzer pilot. M5 and later languages are demand-led, not a promise to finish every ecosystem on this timeline.

### 17.2 M0 work packages

| ID | Work | Completion criterion |
|---|---|---|
| M0-01 | Move shared contracts out of the side-effectful entrypoint and expose one analysis function | Importing the core does not parse CLI args, run Git, write files, or call a model |
| M0-02 | Build real Git revision fixtures and baseline graph/traversal tests | Tests cover supported imports, cycles, multiple paths, and current known omissions |
| M0-03 | Resolve and record immutable comparison identity; source target consistently | Explicit non-HEAD target and dirty checkout cannot produce mislabeled evidence |
| M0-04 | Write per-run outcomes and artifacts atomically | No previous successful result can masquerade as a new no-change/failed run |
| M0-05 | Make AI optional and persist deterministic evidence first | Missing API key/provider outage does not destroy useful analysis |
| M0-06 | Introduce changed-path inventory and structured gaps | Unsupported/deleted/module-level changes remain visible |
| M0-07 | Add source-egress approval and bounded context generation | Private source is not automatically sent during routine onboarding |
| M0-08 | Add CI and packaging/runtime policy | Existing checks and a packaged CLI smoke test pass on declared environments |

### 17.3 M1 work packages

Implement scope-qualified snapshot identities; extract arrows, methods, function expressions, and modules; preserve call-site evidence; support JS deliberately; build the base graph; match entities conservatively; handle deletions; add initial change categories; replace unbounded path enumeration with bounded reachability/explanations.

Do not combine every syntax form into one unreviewable change. Add extraction, fixtures, capability metadata, and limitations together. Defer difficult dispatch rather than presenting approximate edges as certain.

### 17.4 M2 work packages

Select the pilot stack and supported versions. Detect its project boundaries. Implement route or JSX/component registration rules, surface identities, approved journey/persona mappings, and explicit unsupported dynamic registrations. Evaluate historical PRs before expanding to another framework.

The first end-to-end acceptance example should show a shared function change reaching more than one real supported surface, with a human-readable reason and a visible unknown case.

### 17.5 M3 and M4 work packages

Freeze an initial manifest schema with canonical examples; implement tenant-authorized jobs/artifacts; add provider webhook integration; build the minimal report/evidence/review dashboard; record stale revisions; implement context review, audit, retention, usage, operational retry, and deletion workflows.

Roll out in shadow mode. Compare the report with current QA planning before introducing any blocking CI policy. Use actual support time and cost measurements to decide pilot packaging.

### 17.6 Ownership and dependencies

| Role | Primary responsibility |
|---|---|
| Analyzer lead | Evidence model, extraction, graph correctness, matching, propagation |
| Backend/platform engineer | Jobs, tenancy, source access, storage, API, operational controls |
| Dashboard engineer | Persona views, evidence UX, review workflow, accessibility |
| QA/evaluation owner | Ground truth, fixture corpus, critical cases, quality metrics |
| Verification engineer | Planner/executor contracts, test selection/generation, authorized environments |
| Founder/product owner | Pilot stack selection, customer discovery, business expectations, pricing decisions |

These are responsibilities, not a hiring requirement for six full-time people. A small team can share roles, but every milestone needs a named decision owner and independent review of critical correctness/security work.

## 18. Business and Commercial Plan

### 18.1 Positioning

Graphentra is change-impact intelligence for regression planning, with optional focused verification later. The initial buyer pays for a clearer, faster decision about what to check, not merely for a graph or an AI-generated summary.

The strongest differentiation to earn is trustworthy change-to-surface mapping with inspectable evidence, visible uncertainty, useful output without complete test coverage, and application-specific knowledge that improves through review.

### 18.2 Initial customer profile

Target teams with a supported TypeScript web application, frequent PRs/releases, shared business logic, and manual or mixed regression planning. The champion is likely a QA lead, engineering lead, or senior developer. The budget owner is usually an engineering manager, founder, or head of engineering.

Avoid first pilots that require many languages, unrestricted production access, complex enterprise deployment, or a complete automation rewrite. Those customers can inform later demand without determining the first implementation.

### 18.3 Alternatives and validation

Customers currently use manual dependency knowledge, broad regression suites, code search, static analysis, coverage/test-selection products, and general AI code assistants. Validate where Graphentra adds value relative to their actual workflow.

Do not claim competitors lack a feature or that Graphentra is more accurate without a current controlled comparison. Public positioning should state the tested stack and support level.

### 18.4 Discovery and pilot process

1. Interview 8-10 QA/engineering leads about a recent actual change, not hypothetical enthusiasm for AI.
2. Identify three design partners with permissioned repositories and a reviewer responsible for ground truth.
3. Agree source privacy, supported scope, critical journeys, and measurable success criteria before analysis.
4. Review 10-20 historical changes per partner where feasible, including difficult and low-impact cases.
5. Run upcoming changes in shadow mode and compare report usefulness/planning time against the existing process.
6. Record relevant findings, irrelevant findings, missed areas, clarifications, onboarding effort, and cost.
7. Offer a paid continuation only when a repeatable benefit is visible.

Use customer-specific baselines; avoid presenting fewer suggested tests as a success if critical scope is missed.

### 18.5 Packaging and pricing hypotheses

| Package | Proposed value | Preconditions |
|---|---|---|
| Assisted pilot | One repository, bounded duration, setup and weekly evidence review | Clear privacy terms and success criteria |
| Analyzer workspace | Active repositories, analysis allowance, reports/history, human review | Reliable supported scope, onboarding, cost accounting |
| Team collaboration | Additional workflows, approved context, richer review/retention controls | Proven usage and support capacity |
| Verification add-on | Selected tests/generated scenarios and authorized execution allowance | Separate execution safety, reliability, and metering |
| Private deployment | Customer-hosted analysis or control plane | Demand that justifies operational and support cost |

The existing playbook's USD 100-300 per workspace/month is an interview anchor, not validated pricing. Test it against measured value and usage. Do not promise unlimited repositories, analyses, model tokens, or browser execution.

Set allowances using observed workload distribution. Analysis jobs, AI narration, and browser minutes have different cost drivers and should not be hidden in one unbounded unit.

### 18.6 Value and unit economics

Illustrative customer-value formula:

```text
monthly planning value
  = reviewed changes per month
  * measured minutes saved per change / 60
  * customer-approved loaded hourly cost
```

For example, 20 changes times 20 minutes saved is about 6.7 hours. At an assumed USD 40/hour, that is about USD 267/month. These are illustrative inputs, not measured product results. Additional coordination or execution savings must be demonstrated rather than assumed. Do not count hypothetical prevented incidents as guaranteed recurring savings.

Track contribution cost explicitly:

```text
variable cost per analysis
  = worker compute
  + model usage and retries
  + source/artifact storage and transfer
  + metered third-party services

workspace contribution
  = subscription and usage revenue
  - variable analysis/execution costs
  - allocated onboarding and ongoing support cost
```

Measure cache hit rate, heavy repositories, retry storms, support time, and failed jobs. Set gross-margin goals only after real costs are known. Keep execution economics separate from analyzer economics.

### 18.7 Business metrics and go/no-go

Track activation time, weekly useful analyses, reviewer acceptance, material omissions, planning-time reduction, repeat usage, paid conversion, retention, support burden, and contribution margin. A high number of generated reports is not evidence of customer value.

Continue investing when design partners use reports repeatedly, can explain their benefit, and will pay at sustainable cost. Narrow scope when noise or onboarding dominates. Delay language expansion if the first supported stack is not trustworthy. Delay Playwright generation if expected outcomes and surface mappings are inadequate.

### 18.8 Go-to-market and defensibility

Lead with a concrete before/after demonstration: one shared change, multiple justified affected areas, one visible uncertainty, and a focused review plan. Use engineering content and permissioned pilot case studies. Integrations should fit existing PR/QA workflows instead of requiring an immediate dashboard migration.

Defensibility comes from maintained framework rules, evaluated fixtures, reliable identity/impact handling, approved customer context, and feedback quality. Customer code and private mappings must not be reused for cross-customer training or public examples without explicit permission.

## 19. Operations and Cost Management

### 19.1 Telemetry

Capture job IDs, tenant-safe repository identifiers, stage duration, source/file counts, entity/edge counts, unresolved references, unsupported changed paths, traversal budgets, cache hits, memory, model usage, and failure codes.

Monitor queue age, lease expiry, cancellation latency, provider error rates, partial-analysis rate by adapter, stale-context frequency, and cost outliers. Use correlation IDs across API, worker, and provider calls without placing code or credentials in logs.

### 19.2 Incremental analysis

Cache snapshots by immutable revision plus engine/adapter versions, configuration, dependency/build metadata, and relevant source hashes. Reusing only a file hash is unsafe when imports, exported types, framework configuration, or dependencies change resolution.

Invalidate affected dependents conservatively. Lockfile/compiler/config changes may require a broader rebuild. Maintain an uncached reference mode and continuously compare cached output against it. Tenant isolation applies to caches; do not create cross-customer source leakage through deduplication.

### 19.3 Operational recovery

Support retriable versus permanent failures, stage checkpoints, safe artifact cleanup, cancellation acknowledgement, stuck-job recovery, and provider budget exhaustion. A cancelled worker must stop source/model work and remove temporary credentials/workspaces according to policy.

Back up metadata and approved context; test restore procedures. Define recovery objectives with paying customers rather than claiming an untested SLA. Provide a deletion and incident-response runbook before handling broader private-repository workloads.

### 19.4 Capacity policy

Enforce per-tenant concurrency, per-repository size limits, maximum artifact retention, provider spend caps, and fair scheduling. Reject or defer oversized jobs explicitly. Record which budgets affected completeness. Do not silently truncate evidence to meet a model context window.

## 20. Risks and Open Decisions

### 20.1 Risk register

| Risk | Consequence | Mitigation |
|---|---|---|
| False negatives presented as certainty | Teams omit important verification | Explicit support matrix, critical fixtures, visible partial scope, shadow rollout |
| Excessive dependency noise | Users ignore reports | Typed propagation, surface grouping, transparent ranking, measured precision |
| Working-tree/revision mismatch | Incorrect evidence attached to a PR | Immutable source snapshots and resolved comparison metadata |
| Entity identity collisions | Wrong matches and paths | Scoped snapshot IDs and separate reviewed correspondence |
| Framework/version drift | Previously correct mappings become wrong | Versioned adapters and maintained compatibility fixtures |
| Dynamic behavior | Missing routes/callers | Unresolved boundaries, optional approved runtime evidence, conservative scope |
| Stale/incorrect context | Misleading business interpretation | Provenance, review states, applicability hashes, invalidation |
| AI hallucination or injection | Invented impact or unsafe recommendations | Deterministic authority, reference validation, egress/tool restrictions |
| Source leakage | Customer trust/security failure | Opt-in egress, minimization, tenant isolation, retention and audit controls |
| Graph/path explosion | Timeouts and high cost | Reachability-first algorithms, budgets, explicit frontiers |
| Too many ecosystems too early | Maintenance outpaces value | Demand-led adapters with capability gates |
| Premature automation | Wrong or dangerous tests | Approved oracle, separate execution grants, controlled data/environments |
| Product scope expansion | Dashboard/execution delays analyzer value | CLI-first evidence, shared manifest, independent milestones |

### 20.2 Decisions requiring explicit approval

| Decision | Recommended starting point | Owner |
|---|---|---|
| First pilot framework | Choose one actual TS/JS application and its narrow stack | Product + analyzer lead |
| Initial comparison modes | Immutable direct revision pair; add merge-base explicitly | Analyzer lead |
| Source hosting | Local/CI first, then restricted hosted workers | Product + security/backend owner |
| External-model default | Disabled until repository/workspace approval | Product + security owner |
| Runtime/tool versions | Pin supported Node, TS, parser, native-worker versions at implementation | Analyzer/platform leads |
| First manifest version | New named contract; document any real legacy consumers before migration | Analyzer + consumers |
| Criticality ownership | Human-approved repository context and policy | QA/product owner |
| First additional language | Select from actual design-partner demand | Product + analyzer lead |
| Context storage | Versioned file locally; database-backed review in hosted mode | Analyzer + backend |
| Product licensing | Review current package license and commercial distribution intentions | Founder/legal |
| Retention/data region | Define per deployment and customer terms before onboarding | Founder + platform/security |
| Release authority | Remains with customer policy; analyzer is advisory initially | Product + customer |

These open decisions do not block M0 correctness work. They do block making unsupported commercial or compatibility promises.

## 21. Instructions for Implementation Agents

### 21.1 Before writing code

1. Read this document's current-state section, the README, and the files relevant to the selected milestone.
2. Inspect Git status and preserve unrelated/user changes. Existing docs or generated artifacts may be untracked.
3. Reconfirm the current source baseline; do not assume this document remains synchronized after later commits.
4. Identify the smallest requirement and acceptance fixture for the task.
5. Confirm whether the task changes deterministic evidence, advisory interpretation, or downstream execution. Keep those authorities separate.
6. Check current official library documentation before introducing version-specific APIs or native tooling.

### 21.2 Implementation rules

- Preserve working behavior while extracting testable boundaries; avoid a wholesale rewrite merely to match a diagram.
- Do not import the current side-effectful `src/index.ts` at runtime from new library/tests; move shared types/contracts deliberately.
- Add a failing fixture for the concrete bug/capability before broadening behavior where practical.
- Keep all paths and source references tied to the correct revision and coordinate system.
- Do not add a relation without specifying direction, provenance, and impact-propagation rules.
- Do not call parsed syntax "supported impact analysis" until semantic and negative cases are tested.
- Never downgrade unknown scope to "no impact" to make tests or the UI simpler.
- Keep AI optional and unable to mutate deterministic facts.
- Do not auto-upload full repositories, read unrelated secrets, or invoke real model calls in ordinary tests.
- Introduce migrations/compatibility code only for actual persisted contracts or known external consumers.
- Keep changes small and use existing repository conventions unless a task explicitly changes them.
- Update capability documentation and fixtures alongside feature changes.

### 21.3 Definition of done for a work item

The requirement is implemented, positive and negative fixtures exist, relevant existing checks pass, output contracts are validated, known unsupported cases are visible, privacy boundaries are preserved, and documentation distinguishes the new capability from remaining plans.

For graph or caching work, include deterministic-output comparisons. For API work, include authorization and duplicate-delivery/idempotency tests. For AI work, include malformed/adversarial output and provider failure cases. For generated-test work, include missing-oracle and unauthorized-execution cases.

Report what changed, what was verified, and what remains unsupported. Do not mark a future milestone complete merely because its types, mock UI, or documentation exist.

### 21.4 Recommended first implementation task

Extract an import-safe analyzer entrypoint and shared contracts while preserving current helper behavior, then add a real two-revision Git integration fixture. Use that seam to implement immutable comparison identity and a deterministic-only result path. This creates a trustworthy foundation for every later language, framework, API, and dashboard feature.

## 22. Glossary and References

### 22.1 Glossary

| Term | Meaning |
|---|---|
| Entity | A supported semantic unit such as a function, type, component, or endpoint |
| Edge/relation | A typed connection with evidence and declared direction |
| Snapshot | Extracted evidence for one immutable source/configuration state |
| Change seed | An added, removed, or modified entity from which analysis begins |
| Impact finding | A justified recommendation that an entity/surface deserves attention |
| Blast radius | Reachable supported dependencies under explicit rules and budgets; not proof of failures |
| Surface | An observable entrypoint such as a screen, API operation, job, or command |
| Journey | An approved business workflow spanning one or more surfaces |
| Persona | Either a Graphentra product role or an application-user role; always distinguish them |
| Provenance | How a fact or mapping was obtained, from which revision, tool, rule, or reviewer |
| Oracle | The justified expected outcome used to evaluate a verification check |
| Partial analysis | Useful evidence accompanied by scope that could not be analyzed |
| Verification | Execution or review of specific checks under recorded conditions, separate from impact inference |

### 22.2 Repository evidence

- [README and current commands](../README.md)
- [Current orchestration, graph, context, and artifacts](../src/index.ts)
- [CLI parser](../src/cli.ts)
- [Diff and function-scoped evidence](../src/change-evidence.ts)
- [QA evidence and prompt](../src/qa-evidence.ts)
- [LLM client and validation](../src/llm-client.ts)
- [Existing tests](../test/)
- [Package configuration](../package.json)
- [Broader business and verification playbook](Graphentra_Business_and_Technical_Playbook%20%281%29.md)

The existing playbook references earlier materials not included in this checkout. Their contents are not independently verified here. Local generated `dist/` or `.graphentra/` files are not evidence that the current source has passed a fresh run.

### 22.3 External documentation consulted

- [Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/): syntax-tree parsing, incremental parsing, bindings, and grammar ecosystem. This supports evaluating it as a parser, not claiming it supplies semantic call resolution.
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/): schema-driven API boundaries. Schemas are application code; do not compile arbitrary user-supplied schemas.
- [Playwright best practices](https://playwright.dev/docs/best-practices): user-visible behavior, isolated tests, resilient locators, web-first assertions, and controlled test data.

These official pages were consulted during preparation. Context7 tools were not available in the authoring session, so official documentation was used directly. Other future tooling in the technology matrix remains a candidate requiring a focused implementation-time evaluation; no latest-version or integration-compatibility claim is implied.

---

**North star:** A reviewer should be able to open any Graphentra finding and answer: what changed, which supported evidence connects it to this behavior, why it matters, what is still unknown, and what would verify it. Every language adapter, API, dashboard persona, and generated test should strengthen that chain rather than obscure it.
