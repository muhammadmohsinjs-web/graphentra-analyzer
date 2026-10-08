# Graphentra Modern App Fixture (the "before" picture)

A small TypeScript project (~15 files) full of constructs that real React, Next and Nest code uses: arrow functions, classes, components and callbacks passed by reference. `fixtures/test-project` only has named function declarations, so it cannot show improvement. This fixture can.

The goldens `modern-app-*.json` in `packages/analyzer/test/golden/` record what the analyzer does **today**. They are the baseline for Phases 1 to 4. When support improves, regenerate them deliberately with `UPDATE_GOLDENS=1 npm test --workspace=@graphentra/analyzer` and review the diff: the diff is the improvement.

No dependencies are installed. React and Express are replaced by local stubs (`src/stubs/react.ts`, `src/types/jsx.d.ts`, `src/server/router.ts`).

Check it compiles: `npx tsc --noEmit -p fixtures/modern-app`

## Project structure

```
modern-app/
├── tsconfig.json          # jsx: preserve, strict
├── src/
│   ├── types.ts           # Item, Order
│   ├── utils/             # format.ts, math.ts, ids.ts
│   ├── services/          # logger.ts, order-service.ts, inventory.ts
│   ├── components/        # OrderRow.tsx, OrderList.tsx, Summary.tsx
│   ├── server/            # router.ts (stub), handlers.ts, app.ts
│   ├── app/orders/page.tsx  # Next-style page
│   ├── stubs/react.ts     # local hook stubs
│   └── types/jsx.d.ts     # global JSX types
└── tests/                 # order-service.test.ts, handlers.test.ts
```

## Expectations table

"Supported today?" reflects the analyzer at the P0-8 baseline: it extracts only `function name() {}` declarations and the calls between them.

| # | Construct | Where | Ideal analyzer should report | Supported today? |
|---|-----------|-------|------------------------------|------------------|
| 1 | Named function declaration | `utils/format.ts` `slugify`, `titleCase` | function entity | Y |
| 2 | Default-exported function declaration | `utils/format.ts` `slugify`, `app/orders/page.tsx` `OrdersPage` | function entity, default export | Y (entity only) |
| 3 | Nested function declaration | `utils/math.ts` `add` inside `sum` | function entity, `sum` CALLS `add` | Y (entity only, since `sum` is an arrow) |
| 4 | Arrow function in `const` | `utils/format.ts` `formatPrice`, `utils/math.ts` `sum`, `orderTotal` | function entity + CALLS edges | N |
| 5 | Function expression in `const` | `utils/format.ts` `pad`, `server/handlers.ts` `health` | function entity | N |
| 6 | Non-exported arrow helper | `utils/ids.ts` `counter`, `server/app.ts` `logRequest` | function entity, CALLS edges | N |
| 7 | Class declaration | `services/logger.ts`, `services/order-service.ts` | class entity | N |
| 8 | Methods, constructor, getters | `OrderService.add/total/count`, `Logger.info/lineCount` | method entities, CALLS edges | N |
| 9 | Static method + `new Service()` | `OrderService.create`, `createDefaultService` | method entity; CALLS/instantiation edge to constructor | N |
| 10 | Private method called by public method | `OrderService.record` | method entity, CALLS edge | N |
| 11 | Object-literal methods | `services/inventory.ts` `inventory.reserve/release` | method entities, CALLS edges | N |
| 12 | Function component | `components/OrderRow.tsx` `OrderRow` | function entity | Y (entity only; no render edges) |
| 13 | Const arrow component | `components/OrderList.tsx` `OrderList`, `Summary.tsx` `Summary` | component entity | N |
| 14 | `<Child />` render | `OrderList` renders `OrderRow`, `Summary`; `page.tsx` renders `OrderList` | RENDERS edge | N |
| 15 | Hooks | `useState/useEffect/useMemo` in components | CALLS edges to hook functions | N (hook definitions are `function` declarations so they are entities, but no edge is drawn from components) |
| 16 | Callback passed by reference | `onClick={handleClear}`, `orders.map(renderRow)` | REFERENCES edge | N |
| 17 | Router wiring by reference | `server/app.ts` `router.get('/orders', listOrders)` | REFERENCES edge, route entry point | N |
| 18 | Arrow request handlers | `server/handlers.ts` `listOrders`, `createOrder` | function entities, entry points | N |
| 19 | Test-role functions | `tests/*.test.ts` `test(...)` callbacks | test entities linked to code under test | N |
| 20 | Overloaded function | (see below) | one function entity | **Crash** |

## Known analyzer crash: overloaded functions

A TypeScript overload (`function clamp(n: number): number; function clamp(n: number[]): number[]; function clamp(...) {...}`) declares the same name several times. Today `packages/analyzer/src/technical-graph.ts` throws `GraphentraError('Duplicate function identity in source.', 'AMBIGUOUS_ENTITY_ID')` and the whole analysis aborts.

The overload is **not** in this fixture's source, because it would make every golden an error. It is documented here as a Phase 1 item: once overloads are handled, add an overloaded `clamp` back to `utils/math.ts` and add a scenario.

## Golden scenarios (`packages/analyzer/test/golden.test.ts`)

| Scenario | Edit | Outcome today | What it will show later |
|----------|------|---------------|-------------------------|
| `modern-app-no-changes` | none | `no_changes` | entity count grows from 9 as extraction improves |
| `modern-app-arrow-function-edit` | `formatPrice` `toFixed(2)` to `toFixed(3)` | `no_supported_changes` | `completed` with blast radius through `OrderService.total` and the handlers |
| `modern-app-class-method-edit` | `OrderService.total` | `no_supported_changes` | `completed` with callers in handlers and tests |
| `modern-app-component-edit` | `OrderList.tsx` | `no_supported_changes` | `completed` with `OrdersPage` as impacted |
| `modern-app-named-function-edit` | `slugify` | `completed` | same, plus more dependents |
