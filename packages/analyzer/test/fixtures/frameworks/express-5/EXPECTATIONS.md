# express-5 expectations (express 5.0.0)

| expected surface id | kind | file | detected? |
| --- | --- | --- | --- |
| `api:GET /health` | api_endpoint | src/app.ts | yes |
| `api:POST /login` | api_endpoint | src/app.ts | yes |
| `api:GET /api/orders/:id` | api_endpoint | src/app.ts | yes |
| `api:POST /api/orders` | api_endpoint | src/app.ts | yes |
| `api:GET /api/orders/:id/summary` | api_endpoint | src/app.ts | yes |

## Known not detected

- Inline handlers (`/health`, `/login`) have no entry entity ids because they are anonymous functions.
- Route-level middleware (`requireAuth`, `express.json()`) is not a surface; `requireAuth` is not asserted as an access hint here.
- Routers defined in other files and mounted via imports are not covered by this fixture.
