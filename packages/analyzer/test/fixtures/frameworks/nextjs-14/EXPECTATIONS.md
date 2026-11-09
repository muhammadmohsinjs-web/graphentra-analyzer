# nextjs-14 expectations (next 14.2.5)

Rows marked `yes` are asserted by `test/adapter-certification.test.ts`; rows marked `no (gap)` must stay undetected until the adapter changes (then update this file and the golden).

| expected surface id | kind | file | detected? |
| --- | --- | --- | --- |
| `ui:/` | ui_route | app/page.tsx | yes |
| `ui:/products/[id]` | ui_route | app/(shop)/products/[id]/page.tsx | yes |
| `ui:/products/:id` | ui_route | app/(shop)/products/[id]/page.tsx | no (gap) |
| `ui:/legacy` | ui_route | pages/legacy.tsx | yes |
| `api:GET /api/orders` | api_endpoint | app/api/orders/route.ts | yes |
| `api:POST /api/orders` | api_endpoint | app/api/orders/route.ts | yes |
| `api:ANY /api/health` | api_endpoint | pages/api/health.ts | yes |

## Known not detected

- Dynamic segments stay as `[id]` in the route instead of `:id`, so route matching against links/requests using `/products/42` cannot work (gap).
- `app/layout.tsx` is not a surface (by design: layouts wrap pages and have no route of their own).
- The `(shop)` route group is correctly dropped from the route (verified by `ui:/products/[id]`).
- `pages/api/*` default handlers are reported with method `ANY`; real methods checked inside the handler are not split out.
