# Graphentra Sample Test Project

A lightweight TypeScript project designed for evaluating and testing Graphentra Analyzer across diverse code dependency scenarios.

All functions are implemented as named function declarations (`function name(...)`) matching the analyzer's current AST extraction capabilities.

---

## Project Structure

```
test-project/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── billing.ts        # Payment processing and invoicing
│   ├── inventory.ts      # Stock checks with private helper
│   ├── notifications.ts  # Email notification workflows
│   ├── orders.ts         # Multi-step checkout coordination (Entrypoint)
│   ├── pricing.ts        # Tax, discount, and order total calculations
│   ├── standalone.ts     # Completely isolated functions (zero connections)
│   └── utils.ts          # Shared leaf utilities and standalone helpers
└── tests/
    └── orders.test.ts    # Test-role functions for role partitioning tests
```

---

## Scenario Catalog

### 1. Deep Linear Chain (Multi-Depth Traversal)
- **Path:** `handleCheckout` (depth 3) $\to$ `submitOrder` (depth 2) $\to$ `processPayment` (depth 1) $\to$ `chargeCard` (leaf)
- **What it tests:** Changing `chargeCard` in `billing.ts` should produce reverse blast-radius paths reaching `processPayment`, `submitOrder`, and `handleCheckout`.
- **Expected Terminal Dependent:** `handleCheckout` (has callees, but no incoming callers).

### 2. Fan-In / Shared Utility
- **Callee:** `formatCurrency` in `src/utils.ts`
- **Callers across 3 different files:**
  1. `calculateOrderTotal` (`src/pricing.ts`)
  2. `renderInvoiceSummary` (`src/billing.ts`)
  3. `sendReceiptEmail` (`src/notifications.ts`)
- **What it tests:** Editing `formatCurrency` exercises a multi-subsystem blast radius spanning pricing, billing, and notification domains.

### 3. Fan-Out / Subsystem Aggregator
- **Caller:** `submitOrder` in `src/orders.ts`
- **Outgoing calls across 4 different files:**
  - `reserveStock` (`src/inventory.ts`)
  - `calculateOrderTotal` (`src/pricing.ts`)
  - `processPayment` (`src/billing.ts`)
  - `sendOrderConfirmation` (`src/notifications.ts`)
- **What it tests:** Verifies outbound caller attribution and cross-module coordinate clipping.

### 4. Non-Exported Internal Helper
- `sanitizeSku` in `src/inventory.ts` is a private, non-exported function called by `checkInventory`.
- **What it tests:** Proves that Graphentra discovers local, non-exported function declarations and tracks file-internal `CALLS` edges.

### 5. Pure Standalone Functions (Zero Connections)
- `slugify` and `generateId` in `src/utils.ts`
- `validateZipCode`, `hashString`, and `parseQueryString` in `src/standalone.ts`
- **What it tests:** Editing any of these functions must result in `totalAffectedEntities = 0`, empty direct dependents, and empty blast radius paths, confirming no spurious edges are introduced.

### 6. Test-Role Partitioning (`production` vs `test`)
- Functions in `tests/orders.test.ts`:
  - `testSubmitOrder` calls `submitOrder`
  - `testOrderTotalCalculation` calls `calculateOrderTotal`
  - `testStandaloneZipValidation` calls `validateZipCode`
- **What it tests:** Callers located in `tests/` are automatically tagged with `sourceRole: "test"` and separated into `testDependents`, ensuring test suites are not reported as user-facing application impact.

---

## Function & Connection Matrix

| Function | File | Exported | Calls (Outgoing) | Called By (Incoming) | Scenario Role |
|---|---|---|---|---|---|
| `roundToTwo` | `src/utils.ts` | Yes | *None* | `formatCurrency` | Leaf utility |
| `formatCurrency` | `src/utils.ts` | Yes | `roundToTwo` | `calculateOrderTotal`, `renderInvoiceSummary`, `sendReceiptEmail` | Fan-In shared helper |
| `slugify` | `src/utils.ts` | Yes | *None* | *None* | Standalone utility |
| `generateId` | `src/utils.ts` | Yes | *None* | *None* | Standalone utility |
| `calculateTax` | `src/pricing.ts` | Yes | *None* | `calculateOrderTotal` | Calculation leaf |
| `applyDiscount` | `src/pricing.ts` | Yes | *None* | `calculateOrderTotal` | Calculation leaf |
| `calculateOrderTotal` | `src/pricing.ts` | Yes | `applyDiscount`, `calculateTax`, `formatCurrency` | `submitOrder`, `testOrderTotalCalculation` | Subsystem calculator |
| `sanitizeSku` | `src/inventory.ts` | No | *None* | `checkInventory` | Private file helper |
| `checkInventory` | `src/inventory.ts` | Yes | `sanitizeSku` | `reserveStock` | Inventory helper |
| `reserveStock` | `src/inventory.ts` | Yes | `checkInventory` | `submitOrder` | Inventory service |
| `chargeCard` | `src/billing.ts` | Yes | *None* | `processPayment` | Core payment leaf |
| `processPayment` | `src/billing.ts` | Yes | `chargeCard` | `submitOrder` | Payment coordinator |
| `renderInvoiceSummary` | `src/billing.ts` | Yes | `formatCurrency` | *None* | Terminal billing formatter |
| `sendEmail` | `src/notifications.ts` | Yes | *None* | `sendOrderConfirmation`, `sendReceiptEmail` | Core email leaf |
| `sendOrderConfirmation`| `src/notifications.ts` | Yes | `sendEmail` | `submitOrder` | Notification helper |
| `sendReceiptEmail` | `src/notifications.ts` | Yes | `formatCurrency`, `sendEmail` | *None* | Terminal notification helper |
| `submitOrder` | `src/orders.ts` | Yes | `reserveStock`, `calculateOrderTotal`, `processPayment`, `sendOrderConfirmation` | `handleCheckout`, `testSubmitOrder` | Main order workflow |
| `handleCheckout` | `src/orders.ts` | Yes | `submitOrder` | `testHandleCheckout` | Top-level entrypoint |
| `validateZipCode` | `src/standalone.ts` | Yes | *None* | `testStandaloneZipValidation` | Standalone validation |
| `hashString` | `src/standalone.ts` | Yes | *None* | *None* | Standalone pure function |
| `parseQueryString` | `src/standalone.ts` | Yes | *None* | *None* | Standalone pure parser |
| `testSubmitOrder` | `tests/orders.test.ts` | Yes | `submitOrder` | *None* | Test caller |
| `testHandleCheckout` | `tests/orders.test.ts` | Yes | `handleCheckout` | *None* | Test caller |
| `testOrderTotalCalculation` | `tests/orders.test.ts` | Yes | `calculateOrderTotal` | *None* | Test caller |
| `testStandaloneZipValidation` | `tests/orders.test.ts` | Yes | `validateZipCode` | *None* | Test caller |

---

## How to Test with Graphentra Analyzer

From the root of `graphentra-analyzer`:

### 1. Build the Technical Graph
```sh
npm run analyze -- $(pwd)/test-project
```
This generates `.graphentra/technical-graph.json` inside `test-project/` containing all 25 discovered functions and all mapped `CALLS` relationships.

### 2. Verify TypeScript Compilation
```sh
npx tsc --noEmit -p test-project/tsconfig.json
```
