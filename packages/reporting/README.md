# @graphentra/reporting

LLM impact reporting and the persistent application context for Graphentra.

## What it does

- **Application context (v2):** a business guide to the repository that the QA model reads on every report.
  It is generated once at onboarding and then refreshed incrementally.
- **QA reports** that say what changed, **where** to test it (page or API), **how to get there**, who can
  access it, what data to set up, and exactly what to check.
- Strict schema validation, referential checks (only known surface IDs), and one bounded correction retry.

## How the application context is built (repository only)

The analyzer first builds deterministic evidence from the repository alone, with no LLM involved:

| Artifact | Contents |
|---|---|
| `technical-graph.json` | functions and CALLS edges |
| `application-map.json` | UI routes and API endpoints (Next.js, React Router, route configs, Express-style routers, NestJS); guards and roles; menus, links, and navigate calls; the deterministic click path to each page; frontend requests matched to backend endpoints; Playwright/Cypress flows as plain steps; JSX render edges; per-function fingerprints |
| business signals (in memory) | README/docs excerpts, package description and dependency capability hints (e.g. `stripe` means payments), Prisma/SQL/ORM data models, enums, error/validation/response messages, named constants such as `MIN_ORDER_AMOUNT`, test titles, translation strings, env var names |

`--generate-context` then runs three bounded LLM stages:

1. **Module pass.** Files are batched to fit a budget. Every production function gets a business meaning and a
   visible effect. Concrete business rules keep exact values. Glossary entries and open questions are collected.
   A missing annotation triggers a correction request.
2. **Synthesis.** Produces the application summary, user roles, business features (not folders) with criticality
   and reasons, the glossary, and unknowns.
3. **Surface pass.** For every page and endpoint: its business name, how to reach it (reusing the deterministic
   navigation), access, and the setup needed.

Every item records its `basis` (reviewed, documentation, tests, ui-text, code, or inferred). Every item is also
anchored to IDs: graph entity, surface, and file.

## Lifecycle

```sh
npm run report -- --target <repo> --generate-context   # one-time onboarding
npm run report -- --target <repo> --working-tree       # every change: reuses the context
npm run report -- --target <repo> --refresh-context    # optional: re-describe new/changed functions and new surfaces
```

- The source fingerprint of each described function is stored in the context. When an annotation's fingerprint
  differs from the current code, the QA model is told it describes the **previous** behaviour. For a changed
  function this is exactly the "before" picture it needs.
- Items with `basis: "reviewed"` are never replaced by a refresh. The previous file is kept as
  `application-context.previous.json`.
- Stale references (renamed or deleted functions) are dropped with a warning; they never fail the report.
- Schema 1.0 contexts are migrated in memory. Legacy facts are linked to the functions they mention.

## Usage

```ts
import { analyzeRepository } from '@graphentra/analyzer';
import { generateQAReport, loadOrCreateApplicationContext } from '@graphentra/reporting';

const result = analyzeRepository({ target, comparison: { mode: 'working-tree' } });
const { context } = await loadOrCreateApplicationContext({ contextDirectory, technicalGraph: result.technicalGraph });
const { qaReport, markdownReport } = await generateQAReport(result.evidence, context, { apiKey }, {
  applicationMap: result.applicationMap, // enables where/how-to-test guidance
});
// qaReport.testAreas[]: { area, surfaceIds, howToReach, access, setup, checks[] }
// qaReport.qaChecks is still provided (derived from testAreas) for existing consumers.
```
