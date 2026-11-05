# Simple shop: small changes Graphentra doesn't flag

A tiny TypeScript shop with one job: place an order. Each scenario is a one-line change that breaks the shop in a way a customer would notice, while the code that goes wrong isn't flagged by Graphentra. This is GAP-001.

```
node fixtures/simple-shop/scenarios/run.mjs            # proves each bug and prints Graphentra's score
node fixtures/simple-shop/scenarios/run.mjs --strict   # also fails while Graphentra misses anything
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
| `price-in-dollars` | `getPrice` returns dollars, not cents | Charged **$0.10** instead of $10.00 | `chargeCard` |
| `last-name-first` | `getCustomerName` returns `Lovelace, Ada` | "Thanks **Lovelace,**!" instead of "Thanks Ada!" | `buildReceipt`, `firstName` |

Each one gets harder, because the changed value has further to travel:

| Scenario | How the value reaches the broken code | Would walking forward from the changed function find it? |
|---|---|---|
| `lowercase-code` | `placeOrder` → `stockOf` | Yes, one step |
| `price-in-dollars` | `getPrice` → back to `placeOrder` → `chargeCard` | No, `getPrice` calls nothing |
| `last-name-first` | `getCustomerName` → back to `placeOrder` → `buildReceipt` → `firstName` | No, `getCustomerName` calls nothing |

## What Graphentra reports today

| Scenario | Flagged as changed | Flagged as affected | Should also flag |
|---|---|---|---|
| `lowercase-code` | `placeOrder` | `main.ts` | `stockOf` |
| `price-in-dollars` | `getPrice` | `placeOrder`, `main.ts` | `chargeCard` |
| `last-name-first` | `getCustomerName` | `placeOrder`, `main.ts` | `buildReceipt`, `firstName` |

It finds 0 of the 4 functions that receive a changed value, and wrongly flags 0 of the 9 that don't. The links out of `placeOrder` are in `technicalGraph` every time. The walk only goes toward callers, so it never follows them.

## Scoring

`scenarios/scenarios.json` holds the truth for each scenario. `receivesChangedValue` must be flagged. `doesNotReceiveChangedValue` must not be flagged as receiving the value, even though `placeOrder` calls them too.

In `lowercase-code`, `getPrice`, `chargeCard` and `getCustomerName` don't receive the changed value, but they do stop running, because the order is rejected first.

## Limits

- The app was written with the gap in mind, so passing here doesn't prove a fix. Whole-corpus numbers still decide that.
- It has no test suite of its own, so the runner is the only thing that catches these bugs.
- Change `scenarios.json` only if the app's behavior or this analysis was wrong, not to match a new score.
