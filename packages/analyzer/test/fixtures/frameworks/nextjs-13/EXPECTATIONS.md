# nextjs-13 expectations (next 13.5.6, app router only)

| expected surface id | kind | file | detected? |
| --- | --- | --- | --- |
| `ui:/` | ui_route | app/page.tsx | yes |
| `ui:/dashboard` | ui_route | app/dashboard/page.tsx | yes |
| `api:GET /api/orders` | api_endpoint | app/api/orders/route.ts | yes |
| `api:POST /api/orders` | api_endpoint | app/api/orders/route.ts | yes |

## Known not detected

- `app/layout.tsx` is not a surface (by design).
- Dynamic segments are not covered by this fixture; see nextjs-14 for the `[id]` gap.
