# Adapter capabilities

"Supported" means proven by a fixture in `packages/analyzer/test/fixtures/frameworks/` with an `EXPECTATIONS.md` table and a golden in `packages/analyzer/test/golden/adapters/`, run by `test/adapter-certification.test.ts`. The goldens are the application map (`application-map.json`, the same
for every schema); the schema 3.0 projection of those surfaces is described under "Schema 3.0 projection" below.

## next-app-router (ui_route)

Certified versions: Next.js 13.5.6 (`nextjs-13`), 14.2.5 (`nextjs-14`).

| Detected | Not detected |
| --- | --- |
| `app/**/page.tsx` default export as `ui:<route>` | `layout.tsx`, `loading`, `error`, `template` (not surfaces) |
| Route groups `(name)` dropped from the route | Parallel/intercepting routes beyond `@slot` skipping (not certified) |
| Dynamic segments kept as written in the map (`ui:/products/[id]`); in 3.0 evidence normalized to `:id`, `[...slug]` and `[[...slug]]` → `:slug*` | In 3.0 evidence: `app/` surfaces when the detected `next` major is below 13 (dropped by design, D11; the map keeps them) |
| Nested static segments | |

## next-pages-router (ui_route, api_endpoint)

Certified versions: Next.js 14.2.5 (`nextjs-14`).

| Detected | Not detected |
| --- | --- |
| `pages/*.tsx` default export as `ui:<route>` | Per-method splitting inside `pages/api/*` handlers |
| `pages/api/*` default export as `api:ANY <route>` | `_app`, `_document` (skipped by design) |
| Dynamic segments: map keeps `[id]`, 3.0 evidence uses `:id`, same as the App Router (unit-tested, not fixture-covered for pages) | |

## next-route-handler (api_endpoint)

Certified versions: Next.js 13.5.6, 14.2.5.

| Detected | Not detected |
| --- | --- |
| `app/**/route.ts` exported `GET`/`POST`/... as one surface per method (GET and POST in one file verified) | Handlers not exported by those names (e.g. re-exported wrappers; not certified) |

## http-router / express (api_endpoint)

Certified versions: Express 4.19.2 (`express-4`), 5.0.0 (`express-5`); identical results on both.

| Detected | Not detected |
| --- | --- |
| `app.get/post(path, handler)` | Entry entities for inline anonymous handlers |
| `express.Router()` routes with `app.use('/api', router)` prefix, including route params | Middleware as separate surfaces or access hints (not asserted) |
| Handlers imported from other files resolved to entry entity ids | Routers declared in and mounted from other files (not certified) |

## Schema 3.0 projection (D4, D11)

The application map and 2.x output are unchanged by Phase 5. Only when surfaces are projected into 3.0 evidence:

- Next.js routes (`next-app-router`, `next-pages-router`, `next-route-handler`) get dynamic segments in `:param` form,
  and their ids are rebuilt from it: map `ui:/products/[id]` is evidence `ui:/products/:id`. Endpoint links, test
  `goto` matching and `graphentra.yml` surface ids use the 3.0 form; `/products/42` matches `ui:/products/:id`.
- Next.js below 13: `app/` surfaces (`next-app-router`, `next-route-handler`) are left out of evidence with one
  `NEXT_APP_ROUTER_UNSUPPORTED` info diagnostic listing their map ids. An unknown `next` major keeps them.
- Confidence (D11): a framework detected with an uncertified or unknown major gives `likely` surfaces and one
  `FRAMEWORK_VERSION_NOT_CERTIFIED` info per adapter. The dependency-gated adapters (`nextjs-app-router`,
  `nextjs-pages-router`, `nextjs-route-handler`, which run only because `next` is a dependency) get the same when the
  project's `package.json` gives no `next` version at all. Syntactic adapters (`route-config`, `react-router`, `nestjs`,
  and `express-declarative` / `http-router` when they ran without their package) have no framework package to version:
  their surfaces stay `proven`, uncertified, without a diagnostic.

## config (any kind, schema 3.0)

Surfaces declared under `surfaces:` in `graphentra.yml` (D12) are recorded with adapter id `config`, `source: config`,
`confidence: proven`. A declared surface replaces a detected surface with the same id. A surface whose `handler` is not an
entity of the analyzed graph is dropped with a `CONFIG_SURFACE_HANDLER_NOT_FOUND` warning. A `ui_route` id must be
`ui:<route>` and an `api_endpoint` id `api:<METHOD> <route>` (method `ANY` when omitted); a mismatched or duplicate id,
or an `ignore` / `tests` entry that is not a project-relative path (leading `/`, `..` segment, `//`, empty), makes the
file `CONFIG_INVALID` (error with `file:line`): the whole config is ignored and analysis continues. `tests:` entries use
the same matching as `ignore:`: a bare directory such as `qa` covers `qa/**`.

| Detected | Not detected |
| --- | --- |
| Client calls (`fetch`, axios, wrappers) inside an entity, linked to api surfaces as `CALLS_ENDPOINT` (D9) | Client calls at module top level (no enclosing entity) |
| Unresolvable call URLs as `dynamic_endpoint_url` frontier items | Proxied or runtime-computed base URLs |
| Playwright `goto` / Cypress `visit` routes as `TEST_COVERS` (via `goto`) to ui surfaces; test references as `TEST_COVERS` (via `import`) | Routes reached by clicking links inside a test |
