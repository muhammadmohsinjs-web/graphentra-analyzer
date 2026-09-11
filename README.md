# graphentra-analyzer

Graphentra retrieves TypeScript function change evidence deterministically, then uses
OpenRouter through the OpenAI Node SDK to interpret QA consequences. The LLM never
builds or overrides the CALLS graph. Supported entity/relation scope is unchanged.

## Run and verify

```sh
npm run analyze -- /absolute/path/to/demo-repository
npm run build
node dist/index.js --target /absolute/path/to/demo-repository --base HEAD~1 --head HEAD --report /tmp/graphentra-report.md
npm test
npm run typecheck
```

Set `OPENROUTER_API_KEY` and optionally `OPENROUTER_MODEL`. The default comparison
is `HEAD~1..HEAD`; `BASE_SHA` and `HEAD_SHA` select a different comparison. Analyze
a clean checkout of the comparison's head: graph ranges still come from the
working tree. Tests are offline and mock SDK HTTP responses, not live LLM output.
The long-form CLI options match the GitHub Actions integration. A nested analyzer
checkout is excluded from the target application's TypeScript graph.

GitHub Actions must expose the OpenRouter secret to the analyzer step:

```yaml
env:
  OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

## Unified evidence

Previously, `findChangedEntities()` attached the entire `ChangedFile` to every
matching function. It now reads function ranges from the base revision for removal
ownership and extracts a separate `EntityChange` for each current function.

`src/change-evidence.ts` contains the new/testable helpers:

- `parseGitDiff()`: retains hunks and old/new coordinates for additions, removals,
  and unchanged context. File-wide evidence remains available for diagnostics.
- `getFunctionRanges()`: obtains before-version named function ranges solely for
  removal attribution; it does not construct historical graph relationships.
- `extractEntityChange()`: clips additions to current ranges and removals to old
  ranges, rebuilding the diff without neighboring code or Git's function heading.

`changedLines` uses new-file coordinates. Pure deletions are anchored inside the
surviving function; the clipped diff retains actual old/new patch coordinates.
Deleted functions have no current graph entity and are not reassigned to neighbors.
Renamed/ambiguous old identities may lack removed-code evidence. Overlapping
function line ranges, including functions sharing a line, are skipped with a warning
instead of sending ambiguous evidence. This does not add support for new syntax.

`src/qa-evidence.ts` holds the QA payload/context selection and prompt as
pure functions so they can be tested without starting the CLI:

- `buildLLMPayload()` sends all changed entities in one request while preserving
  isolated change evidence for each function. The payload includes retrieved
  callers/paths, shared scoped context, and limitations, but no whole technical graph.
- `getSourceRole()` tags obvious test paths. All graph relationships remain intact;
  payload entities/paths carry roles and affected callers are also split into
  `productionDependents` and `testDependents`.
- `selectRelevantApplicationContext()` retrieves annotations for all affected entities,
  their domain names, and matching terminology. Unscoped summaries, facts, domain
  descriptions, and unknowns remain persisted but are not sent to the QA request.
  Existing free-text context cannot be perfectly fact-checked; code takes precedence.

The analyzer makes one QA report request for the complete change set. The prompt
requires one overall summary, one to five combined key changes, one to five focused
checks, and at most one material uncertainty. Related service, endpoint, and test
changes must be merged instead of producing one section per function. Test callers
are coverage evidence, not user-facing impact.

The disposable `analysis.json` format is schema version `1.1` and stores the result
as one `qaReport` object rather than a `qaReports` array.

After Zod, `validateImpactReportSemantics()` in `src/llm-client.ts` rejects empty
values, headings/labels, Markdown, incomplete summary/key-change sentences,
technical source/entity identifiers, checks without an allowed imperative verb, and
checks that request source maintenance or automated-test work. Complete sentences
must finish naturally with punctuation. Report text has no hardcoded character ceiling.
One semantic correction is allowed with the same evidence. A second failure throws.
Malformed JSON and Zod failures fail immediately. Raw response-body connection
resets are retried twice with short backoff for both context and report requests;
the SDK's HTTP/connection retries remain separate from this transport recovery and
the one report-correction retry. The lightweight validator does not prove factual
accuracy or count natural-language sentences; those requirements remain explicit
in the system prompt and JSON schema.

## Same-file example

Given separate edits at lines 16 and 150 in `src/ecommerceService.ts`, these remain
two independent `payload.changes[].change` values inside the single unified request
(zero-context patches shown):

```json
{
  "file": "src/ecommerceService.ts",
  "changedLines": [16],
  "removedCode": ["} else if (prod.stock <= 5) {"],
  "addedCode": ["} else if (prod.stock <= 10) {"],
  "diff": "--- a/src/ecommerceService.ts\n+++ b/src/ecommerceService.ts\n@@ -16,1 +16,1 @@\n-} else if (prod.stock <= 5) {\n+} else if (prod.stock <= 10) {"
}
```

```json
{
  "file": "src/ecommerceService.ts",
  "changedLines": [150],
  "removedCode": ["if (cart.items.length === 0) {"],
  "addedCode": ["if (cart.items.length === 50) {"],
  "diff": "--- a/src/ecommerceService.ts\n+++ b/src/ecommerceService.ts\n@@ -150,1 +150,1 @@\n-if (cart.items.length === 0) {\n+if (cart.items.length === 50) {"
}
```

`test/qa-evidence.test.ts` proves that two functions in a single shared hunk retain
isolated change entries in the unified payload: the catalog entry contains no
checkout/cart content, and the checkout entry contains no catalog/stock content.
Actual callers are retained even when another changed function is a dependent.

`test/change-evidence.test.ts` additionally covers separate hunks, shared hunk
context, shifted line numbers with pure deletions, deleted neighboring functions,
outside-function deletions, new files, header-like source text, zero-context
deletions, and replacement blocks spanning adjacent functions.

## Persistent context

The analyzed repository's `.graphentra/application-context.json` is stable semantic
knowledge, not a disposable build output. Existing context is loaded and validated;
missing context is generated once. Commit it to the demo repository or otherwise
persist it and restore it **before** each CI invocation. An ephemeral runner alone
does not provide persistence. There is no database or automatic context refresh.
Review context deliberately as business meaning changes.

Ignore only disposable outputs in the analyzed demo repository:

```gitignore
.graphentra/technical-graph.json
.graphentra/analysis.json
```

Do not ignore the entire `.graphentra/` directory. The analyzer's own ignore file
also separates these artifacts; it does not modify the analyzed repository's ignore
rules. Generated context emits an explicit persistence warning.

## Console contract

File diagnostics intentionally show all file edits; they are **not** separate QA
reports. The analyzer builds deterministic evidence for every changed function, sends
one LLM request, and prints one report. A representative `formatImpactReport()` is:

```text
Summary: Catalog and checkout validation now enforce the intended stock and cart boundaries.

Key changes:
- Zero-stock products are now out of stock, while products with four units remain low stock.
- Empty carts are now rejected instead of carts containing exactly 50 entries.

QA checks:
- Verify stock values of zero and four produce the expected classifications.
- Verify empty and 50-entry carts follow the corrected checkout behavior.
```

The console sequence below uses JSON-escaped Unicode for the existing decorative
markers. Decode the escapes to obtain the literal console lines. Angle-bracket
values are run-dependent and the file block repeats per file. The LLM request and
report blocks appear exactly once. Live LLM wording is not guaranteed to equal the example.

```text

========================================
\ud83d\udd0d GRAPHENTRA ANALYZER
========================================
\ud83d\udcc1 Target: <absolute target>
\ud83d\udcd8 TypeScript files: <count>
\ud83d\udd35 Functions discovered: <count>
\ud83d\udd17 CALLS relations: <count>

\u2705 Technical graph created: <target>/.graphentra/technical-graph.json

\ud83e\udde0 Application Context found.

\ud83d\udcdd Changed TypeScript files: <count>

----------------------------------------
\ud83d\udcc4 <file>
----------------------------------------
Changed lines: <comma-separated file lines>

Removed:
- <removed line, repeated>

Added:
+ <added line, repeated>

\ud83c\udfaf Changed functions: <count>
  \u2192 <changed entity ID, repeated>

\ud83d\udca5 Deterministic impact evidence built for <count> changed functions.

\ud83e\udd16 Sending unified deterministic evidence + relevant application context to LLM...
<request.started JSON>
<optional request.semantic_retry JSON>
<request.completed JSON>

========================================
\ud83e\udd16 UNIFIED QA IMPACT REPORT
========================================

<formatImpactReport output shown above>

========================================
\u2705 GRAPHENTRA ANALYSIS COMPLETE
========================================
Technical graph: <target>/.graphentra/technical-graph.json
Application context: <target>/.graphentra/application-context.json
Analysis: <target>/.graphentra/analysis.json

```

No `Uncertainty:` section is printed for an empty array. No `Removed:`/`Added:`
section is printed for an empty corresponding array. Context generation replaces
the context-found line with:

```text
\u2705 Application Context generated: <target>/.graphentra/application-context.json

\u26a0\ufe0f If this was generated inside GitHub Actions, the file is temporary.
Persist .graphentra/application-context.json in the analyzed repository (commit it or restore it before CI runs).
technical-graph.json and analysis.json are disposable run artifacts, not persistent application context.
```

QA trace shapes (one JSON object per line; optional provider fields may be omitted):

```json
{"timestamp":"<ISO timestamp>","scope":"llm","event":"request.started","traceId":"<UUID>","provider":"openrouter","model":"<model>","evidenceBytes":1234}
{"timestamp":"<ISO timestamp>","scope":"llm","event":"request.semantic_retry","traceId":"<same UUID>","requestId":"<request ID>","completionId":"<completion ID>","provider":"openrouter","model":"<model>","attempt":1,"nextAttempt":2,"errors":["summary must be plain text without headings, field labels, Markdown, or line breaks."]}
{"timestamp":"<ISO timestamp>","scope":"llm","event":"request.completed","traceId":"<same UUID>","requestId":"<request ID>","completionId":"<completion ID>","provider":"openrouter","model":"<model>","attempt":2,"durationMs":1234,"finishReason":"stop","usage":{"prompt_tokens":100,"completion_tokens":100,"total_tokens":200}}
```

On first-attempt success, there is no retry event and `attempt` is `1`. A failed
request emits `request.failed` with `traceId`, `provider`, `model`, `attempt`,
`durationMs`, `errorName`, and `errorMessage` (plus API error metadata when available),
then the existing analysis-failed console output. Invalid reports are not printed
or saved as successful reports. `OPENAI_LOG=off` disables SDK logs, not these traces.
