# Simple shop: small changes that break other code

A tiny TypeScript shop with one job: place an order. Each scenario is a one-line change that breaks the shop in a way a customer would notice, in code the change never touched. The walk toward callers can't find that code, so value flow follows the changed value to it. See GAP-001 and GAP-005 in the gap register.

```
node fixtures/simple-shop/scenarios/run.mjs            # proves each bug and prints Graphentra's score
node fixtures/simple-shop/scenarios/run.mjs --strict   # also fails if Graphentra misses anything
```

The runner works on throwaway copies, so `src/` always stays correct. It saves each `evidence.json` in `.scenario-output/` so you can open it.

## How the shop works

`placeOrder` in `src/shop.ts` is the whole app. It calls everything else and passes values between the functions.

```
                       main.ts
                          │
                          ▼
                      placeOrder
      ┌───────────┬───────┼───────────┬────────────┐
      ▼           ▼       ▼           ▼            ▼
   stockOf    getPrice  chargeCard  getCustomerName  buildReceipt
                                                       │
                                                       ▼
                                                    firstName
```

A correct order of 2 teas:

```json
{ "ok": true, "charged": "$10.00", "receipt": "Thanks Ada! Your TEA-1 is on its way." }
```

## The scenarios

| Scenario | The one-line change | What the customer sees | Code that goes wrong |
|---|---|---|---|
| `lowercase-code` | `placeOrder` calls `stockOf(code.toLowerCase())` | Every order says "out of stock" | `stockOf` |
| `customer-title` | `placeOrder` passes `Ms. Ada Lovelace` to `buildReceipt` | "Thanks **Ms.**!" instead of "Thanks Ada!" | `firstName` (through `buildReceipt`) |
| `price-in-dollars` | `getPrice` returns dollars, not cents | Charged **$0.10** instead of $10.00 | `chargeCard` |
| `last-name-first` | `getCustomerName` returns `Lovelace, Ada` | "Thanks **Lovelace,**!" instead of "Thanks Ada!" | `buildReceipt`, `firstName` |
| `price-table-in-dollars` | The table in `catalog.ts` says `5`, not `500` | Charged **$0.10** instead of $10.00 | `getPrice`, `placeOrder`, `chargeCard` |

Each one gets harder, because the changed value has further to travel:

| Scenario | How the value reaches the broken code | Would walking forward from the changed function find it? |
|---|---|---|
| `lowercase-code` | `placeOrder` → `stockOf` | Yes, one step |
| `customer-title` | `placeOrder` → `buildReceipt` → `firstName` | Yes, but only if the walk goes two steps. One step stops at `buildReceipt`, which is fine, and not at `firstName`, which assumes the first word is the name |
| `price-in-dollars` | `getPrice` → back to `placeOrder` → `chargeCard` | No, `getPrice` calls nothing |
| `last-name-first` | `getCustomerName` → back to `placeOrder` → `buildReceipt` → `firstName` | No, `getCustomerName` calls nothing |
| `price-table-in-dollars` | The table → `getPrice` → back to `placeOrder` → `chargeCard` | No, and neither would walking toward callers, because no function is linked to the table |

## What Graphentra reports today

| Scenario | Flagged as changed | Flagged as affected (callers) | Receives the changed value |
|---|---|---|---|
| `lowercase-code` | `placeOrder` | `main.ts` | `stockOf` |
| `customer-title` | `placeOrder` | `main.ts` | `buildReceipt`, `firstName` |
| `price-in-dollars` | `getPrice` | `placeOrder`, `main.ts` | `chargeCard` |
| `last-name-first` | `getCustomerName` | `placeOrder`, `main.ts` | `buildReceipt`, `firstName` |
| `price-table-in-dollars` | `catalog.ts` module code | Nothing | `getPrice`, `placeOrder`, `chargeCard` |

It finds all 9 functions that receive a changed value, and wrongly flags 0 of the 16 that don't. The report lists them in `receivesChangedValue` on each impact.

## Benchmark

```
node fixtures/simple-shop/scenarios/benchmark.mjs
```

It runs the analyzer on each scenario, scores each `evidence.json` against `scenarios.json`, and shows how far each miss is from the changed code. It builds from the committed `src/`, so uncommitted edits there don't change the score. Results are in `.scenario-output/benchmark.json`.

| All 5 scenarios | Found | Wrongly flagged |
|---|---|---|
| Today (callers plus value flow) | 9 of 9 | 0 of 16 |
| Before: toward callers only | 0 of 9 | 0 of 16 |
| What if: forward 1 step | 2 of 9 | 7 of 16 |
| What if: forward 2 steps | 3 of 9 | 7 of 16 |
| What if: forward, any distance | 3 of 9 | 7 of 16 |
| What if: forward from direct callers too | 6 of 9 | 13 of 16 |

The "what if" rows are worked out from the saved graph, to show why a plain walk wasn't used. This app was written with the gap in mind, so the whole-corpus numbers below decide whether a change is good: `npm run bench:corpus`.

## Scoring

`scenarios/scenarios.json` holds the truth for each scenario. `receivesChangedValue` must be flagged. `doesNotReceiveChangedValue` must not be flagged as receiving the value, even though `placeOrder` calls them too.

In `lowercase-code`, `getPrice`, `chargeCard` and `getCustomerName` don't receive the changed value, but they do stop running, because the order is rejected first.

## Limits

- The app was written with the gap in mind, so passing here doesn't prove a fix. Whole-corpus numbers decide that.
- It has no test suite of its own, so the runner is the only thing that catches these bugs.
- Change `scenarios.json` only if the app's behavior or this analysis was wrong, not to match a new score.
