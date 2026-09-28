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

## How It Works (Simple Step-by-Step)

In short: the **analyzer** reads your git changes and writes JSON files. The **LLM** is only called by the report command, and the **DB** is only written to by the report server.

All output files go into `<target>/.graphentra/`.

### Step 0: Setup (one time)
```sh
npm ci
```
Create `.env` with `OPENROUTER_API_KEY=...` (and optionally `OPENROUTER_MODEL`). You only need this for Steps 2, 3 and 5.

### Step 1: Run the analyzer only (no LLM, no DB)
```sh
npm run analyze:core -- --target ./fixtures/test-project --working-tree
```
- **What it does:** reads the git diff (`--working-tree` = uncommitted changes, or `--base X --head Y` = compare two commits), parses the TypeScript files, finds the functions that changed and which functions call them (the "blast radius").
- **File created:** `.graphentra/evidence.json`
- **API calls:** none. **DB:** none.
- **Output:** `Deterministic evidence created: <path>` plus a summary, diagnostics and limitations.

### Step 2: First time only: generate application context (calls the LLM)
```sh
npm run report -- --target ./fixtures/test-project --working-tree --generate-context
```
- **What it does:** runs the analyzer (Step 1), then sends source code and repo signals to the LLM **(OpenRouter API)** in batches, which describes what each function and feature does in business terms.
- **Files created:** `evidence.json`, `technical-graph.json`, `application-map.json`, `application-context.json`, and `analysis.json` (the QA report, if there were changes).
- **API calls:** OpenRouter: once for the context (several batches), then once for the QA report.
- **Output:** `Application context generated: X/Y functions described...` and then `QA report created for evidence <id>`.

### Step 3: Every change after that: QA impact report (calls the LLM)
```sh
npm run report -- --target ./fixtures/test-project --working-tree --report ./qa-report.md
```
- **What it does:** runs the analyzer, **loads** the saved `application-context.json` (no LLM call for this), then asks the LLM what QA should test based on the changes.
- **Files created/updated:** `evidence.json`, `technical-graph.json`, `application-map.json`, `analysis.json`, and `qa-report.md` if you pass `--report`.
- **API calls:** OpenRouter, 1 call for the QA report. **No call** if nothing changed; it just prints "no changes".
- **Output:** a loader showing `LLM triggered · QA impact report`, then `QA report created for evidence <id>`.
- **Optional:** add `--refresh-context` to re-describe only new/changed functions (LLM call). The old file is kept as `application-context.previous.json`.

### Step 4: View the results in the browser (no LLM, no DB)
```sh
npm run visualize -- ./fixtures/test-project
```
- **What it does:** starts a local server at `http://127.0.0.1:4173` that reads the `.graphentra/*.json` files and shows the graph and the QA report.
- **Files created:** none (read only).

### Step 5: Save reports to the database (optional)
```sh
npm run serve                                                    # terminal 1
npm run analyze:core -- --target ./fixtures/test-project --working-tree
npm run publish:report -- --target ./fixtures/test-project \
  --pr 42 --pr-title "Change discount calculation" --base-branch main   # terminal 2
```
- **`serve`** starts a small HTTP server at `http://localhost:3000` with a SQLite DB file (`reports.db`, or set `DB_PATH`).
- Interactive API documentation is available at `http://localhost:3000/docs`; the OpenAPI 3.0 JSON specification is at `http://localhost:3000/openapi.json`.
- **`publish:report`** reads `<target>/.graphentra/` (`evidence.json`, `application-context.json`, optional `application-map.json`), collects change info (repository, branch, commit, author, PR; from flags, the `GITHUB_*` CI environment, or the local git checkout) and sends `POST /reports`. It skips runs whose outcome is not `completed`.
- `POST /reports` with body `{ evidence, applicationContext, applicationMap?, change? }`: **calls the LLM**, then **stores the row in the DB** (QA report, change info, and the technical inputs).
- **QA-facing reads** (no technical data): `GET /reports` (filter with `?repository=`, `?pr=`, `?branch=`), `GET /reports/:id` (change info + QA report), `GET /reports/:id/md`.
- **Engineer-facing read:** `GET /reports/:id/technical` returns the stored evidence, technical graph, application context and application map.
- This is the **only place data is written to a DB**.

### Step 6: In CI / production (on a pull request)
```sh
graphentra-ci --target . --base <sha> --head <sha> --repo org/repo --pr 42
```
- **What it does:** runs the analyzer, saves `.graphentra/evidence.json`, then sends it with `POST <GRAPHENTRA_BACKEND_URL>/v1/analysis-runs` (needs `GRAPHENTRA_TOKEN`).
- **API calls:** Graphentra backend only. The backend (not in this repo) calls the LLM and saves to its DB.
- **Output:** `Analysis submitted to backend: Run ID: <id> (status: queued)`.
- Use `--resubmit <evidence.json>` to send an existing file again without re-analyzing.

### Quick summary

| Command | Analyzer runs | LLM API called | Files written | DB write |
|---|---|---|---|---|
| `analyze:core` | Yes | No | `evidence.json` | No |
| `report --generate-context` | Yes | Yes (context + report) | all `.graphentra/*.json` | No |
| `report` | Yes | Yes (report only, if changes) | evidence, graph, map, analysis | No |
| `visualize` | No | No | None | No |
| `serve` + `POST /reports` | No | Yes | None | Yes (SQLite) |
| `publish:report` | No | No (server does it) | None | Yes, via `POST /reports` |
| `graphentra-ci` | Yes | No (backend does it) | `evidence.json` | Backend DB |

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
