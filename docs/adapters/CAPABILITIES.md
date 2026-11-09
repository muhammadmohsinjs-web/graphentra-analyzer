# Adapter capabilities

"Supported" means proven by a fixture in `packages/analyzer/test/fixtures/frameworks/` with an `EXPECTATIONS.md` table and a golden in `packages/analyzer/test/golden/adapters/`, run by `test/adapter-certification.test.ts`.

## next-app-router (ui_route)

Certified versions: Next.js 13.5.6 (`nextjs-13`), 14.2.5 (`nextjs-14`).

| Detected | Not detected |
| --- | --- |
| `app/**/page.tsx` default export as `ui:<route>` | `layout.tsx`, `loading`, `error`, `template` (not surfaces) |
| Route groups `(name)` dropped from the route | Parallel/intercepting routes beyond `@slot` skipping (not certified) |
| Dynamic segments normalized: `[id]` → `:id`, `[...slug]` and `[[...slug]]` → `:slug*` (one form for both catch-alls) | `app/` rules when the detected `next` major is below 13 (skipped by design, D11) |
| Nested static segments | |

## next-pages-router (ui_route, api_endpoint)

Certified versions: Next.js 14.2.5 (`nextjs-14`).

| Detected | Not detected |
| --- | --- |
| `pages/*.tsx` default export as `ui:<route>` | Per-method splitting inside `pages/api/*` handlers |
| `pages/api/*` default export as `api:ANY <route>` | `_app`, `_document` (skipped by design) |
| Dynamic segments normalized the same way as the App Router (unit-tested, not fixture-covered for pages) | |

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

## config (any kind, schema 3.0)

Surfaces declared under `surfaces:` in `graphentra.yml` (D12) are recorded with adapter id `config`, `source: config`,
`confidence: proven`. A declared surface replaces a detected surface with the same id. A surface whose `handler` is not an
entity of the analyzed graph is dropped with a `CONFIG_SURFACE_HANDLER_NOT_FOUND` warning.

| Detected | Not detected |
| --- | --- |
| Client calls (`fetch`, axios, wrappers) inside an entity, linked to api surfaces as `CALLS_ENDPOINT` (D9) | Client calls at module top level (no enclosing entity) |
| Unresolvable call URLs as `dynamic_endpoint_url` frontier items | Proxied or runtime-computed base URLs |
| Playwright `goto` / Cypress `visit` routes as `TEST_COVERS` (via `goto`) to ui surfaces; test references as `TEST_COVERS` (via `import`) | Routes reached by clicking links inside a test |
