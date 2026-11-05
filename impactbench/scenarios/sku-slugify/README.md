# Benchmark: SKU conversion in `createOrder`

This records what should be reported for one change to `fixtures/modern-app`, whatever Graphentra finds today. Use it to score analyzer and QA report improvements.

```
node impactbench/scenarios/sku-slugify/run.mjs            # proves the behavior and prints the score
node impactbench/scenarios/sku-slugify/run.mjs --strict   # also fails on a missed or wrongly flagged entity
```

The runner takes the app from the commit pinned in `expected.json` (`baseCommit`) and works on a throwaway copy. Uncommitted edits to the fixture can't change the result, and the fixture stays untouched.

## The change

`introduce-change.patch` is the real change to `src/server/handlers.ts`. `createOrder` rebuilds the order with every SKU converted by `slugify`, then uses that new order for everything after it:

```ts
const body = req.body as Order;
const order: Order = { ...body, items: body.items.map((i) => ({ ...i, sku: slugify(i.sku) })) };
const inStock = order.items.every(i => checkStock(i.sku) >= i.qty);
```

`A-1` is looked up as `a-1`. Stock is usually saved as `A-1`, so the lookup returns 0 and a valid order gets a 409 "out of stock" error.

## What the order flow does

Each row is an order of 2 units at $1, or 1 unit each for the mixed order and the no-code item. The runner checks every value by running the app.

| Order | Before the change | With the change |
|---|---|---|
| In-stock product with a capital letter in its code | 201, saved as `A-1` | **409** |
| In-stock product with an all-lowercase code | 201, saved as `a-1` | 201, saved as `a-1` |
| In-stock lowercase code containing a character `slugify` replaces (`a_1`) | 201, saved as `a_1` | **409** |
| Capitalized and lowercase codes in one order, both in stock | 201, saved as `A-1` and `b-2` | **409** |
| Product that really is out of stock | 409 | 409 |
| `A-1` ordered, stock saved under `a-1` | 409 | **201, saved as `a-1`** |
| Item with no product code | 409 | **Crash** (`slugify` throws and nothing catches it) |

Every accepted order keeps the correct total of $2.00.

Five existing app tests fail with this change, and all five are the valid-order rejection. The other 91 pass, so no test covers the last two rows or the saved code.

The patch doesn't say whether `A-1` matching `a-1` stock is wanted. This benchmark records it as a change that must be reported, not as a bug or a fix.

## What Graphentra should report

| Entity | Why |
|---|---|
| `src/server/handlers.ts#createOrder` | The changed code |
| `src/services/inventory.ts#checkStock` | Receives the converted SKU. This is where the rejection happens |
| `src/services/order-service.ts#OrderService.add` | Receives and saves the order with converted SKUs |
| `src/server/app.ts#buildApp` | Caller |
| `tests/handlers.test.ts#<module>`, `tests/app.test.ts#<module>` | Tests that reach `createOrder` |

It should not flag these, because they don't use the converted SKU and their results don't change:

| Entity | Why |
|---|---|
| `src/utils/math.ts#orderTotal` | Receives the converted order but only reads price and quantity |
| `src/services/order-service.ts#OrderService.total` | Takes the order id and returns a price |
| `src/services/order-service.ts#OrderService.record` | Receives the converted order but only logs its id |

`orderTotal` and `record` are the hard ones. The order does reach them, so telling them apart from `add` means knowing which field each one reads. An analyzer that lists everything the order reaches loses points here.

`slugify` isn't scored. It produces the changed value, and `createOrder` only starts calling it in this change.

## What the QA report should say

- Valid orders for in-stock products can be rejected as out of stock.
- The stock check looks up the converted code, while stock is saved under the original code.
- Codes with capital letters are affected, and so are codes with characters such as underscores.
- One affected product rejects the whole order.
- Saved orders now carry the converted code, so an order can be saved under a different code than the customer sent.
- An order that used to be rejected can now be accepted if stock is saved under the converted code.
- An item with no product code now crashes the request instead of returning 409.
- It should not say that stock counts drop on an order, because `createOrder` only reads stock. It should not say that totals change, because they use only price and quantity.

Nothing in `src/` reads a saved order's codes today, so a customer can't see the saved code yet. The runner reads it directly from the service's private map.

`run.mjs` doesn't score the written report. Compare it by hand against `qaReport` in `expected.json`.

## Score today

Recorded on 2026-11-05 at `bd85cbe`: found 4 of 6, wrongly flagged 0 of 3. The misses are `checkStock` and `OrderService.add` (GAP-001).

## Limits

- The scenario is synthetic and was written with the gap in mind, so it doesn't belong in the D-0 corpus. Passing it doesn't prove a fix; whole-corpus numbers still decide that.
- `checkStock` and `OrderService.add` are one step forward from the changed function. The `excalidraw-11` case is harder, so a fix that passes here may still miss it.
- The runner needs `baseCommit` to stay in the repository. If that commit is ever removed, update it to a commit where the patch still applies and the "before" checks pass.
- If `handlers.ts` is edited further, regenerate the patch so it stays the real change.
- Don't change `expected.json` to match a new score. Change it only if the app's behavior or this analysis was wrong, and say why in the commit.
