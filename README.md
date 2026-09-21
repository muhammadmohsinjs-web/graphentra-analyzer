# Graphentra

Graphentra is a deterministic change-evidence and graph analysis engine for TypeScript repositories, with optional LLM-assisted QA impact reporting and visual exploration.

Production flow:
```text
PR event -> CI checkout -> Analyzer -> Versioned evidence
                                           |
                                           v
                                    CI submission adapter
                                           |
                                           v
                                  Backend API -> LLM -> DB
                                                        |
                                                        v
                                                   Dashboard
```

The analyzer produces deterministic evidence. The CI adapter handles HTTP submission and authentication. Reporting interprets evidence. The backend and dashboard are consumers, not analyzer dependencies.

---

## Workspace Structure & Package Ownership

```text
packages/
  analyzer/       # @graphentra/analyzer: Library, CLI (graphentra-analyze), schema, engine tests (Offline, production dep: typescript only)
  reporting/      # @graphentra/reporting: LLM QA impact reporting, prompt synthesis, application context
apps/
  visualizer/     # @graphentra/visualizer: Local animated graph & evidence visualizer
  ci-runner/      # @graphentra/ci-runner: CI invocation and backend evidence submission adapter
fixtures/
  test-project/   # Canonical test project fixture
tools/
  report.ts       # Local QA reporting orchestrator
  verify-boundaries.mjs
  verify-distribution.mjs
src/              # Backward-compatible root entrypoint adapters
```

---

## Commands & Verification

```sh
# Clean install
npm ci

# Full build in dependency order
npm run build

# Typecheck workspace sources, tests, tools, and root adapters
npm run typecheck

# Offline tests (without live LLM or external credentials)
npm test

# Boundary verification (enforces package isolation and forbidden imports)
npm run verify:boundaries

# Distribution verification (packs, installs, and runs in isolated clean directories outside workspace)
npm run verify:distribution

# Deterministic analysis CLI
npm run analyze:core -- --target ./fixtures/test-project --working-tree

# Local QA LLM report orchestration
npm run report -- --target ./fixtures/test-project --working-tree

# Visualizer server
npm run visualize -- ./fixtures/test-project
```

---

## Deterministic Evidence Contract

The analyzer emits an authoritative, runtime-validated `evidence.json` envelope (`artifactKind: "graphentra-evidence"`, `schemaVersion: "2.0"`):
- **Graph & Analysis together:** The technical graph and analysis are packed in one result envelope, preventing mixed-run graph/evidence bundles.
- **Portable:** Host-specific absolute paths are excluded; target paths are repository-relative.
- **Deterministic Identity:** Stable SHA-256 hash across canonical deterministic fields (`computeDeterministicEvidenceIdentity`), excluding volatile timestamps.
- **Every Outcome Supported:** Generates a valid envelope for `completed`, `no_changes`, `no_supported_changes`, and `no_source_files`.
- **Sensitive Data Note:** Diff hunks and source code snippets are sensitive data and should be handled with least privilege.

---

## CI & Git Requirements

- **Node.js:** `>= 20.0.0`
- **Git:** Git CLI available on PATH.
- **Commit Mode Alignment:** In commit comparison mode, checkout `HEAD` must match the resolved comparison head, with no uncommitted tracked changes or untracked source files that would alter analysis.
- **Working Tree Mode:** Use `--working-tree` to analyze uncommitted working-tree modifications against a base revision (defaults to `HEAD`).
