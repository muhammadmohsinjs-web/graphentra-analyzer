// Places each order from expected.json through the real createOrder and prints what happened to it.
import fs from 'node:fs';
import { createOrder, service } from '../src/server/handlers';
import { inventory } from '../src/services/inventory';
import type { Order } from '../src/types';
import { fakeRes } from '../tests/support/fake-res';

type Case = { stock: Record<string, number>; items: { sku?: string; qty: number }[] };

// The app has no way to read a saved order's codes, so the probe looks at the private map directly.
const savedOrders = (service as unknown as { orders: Map<string, Order> }).orders;

const cases: Case[] = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).behavior;
const outcomes = cases.map((scenario, index) => {
  inventory.stock.clear();
  for (const [sku, count] of Object.entries(scenario.stock)) inventory.stock.set(sku, count);
  const id = `probe-${index}`;
  const { res, out } = fakeRes();
  const items = scenario.items.map(item => ({ ...item, price: 1 }));
  try {
    createOrder({ method: 'POST', path: '/orders', body: { id, items } }, res);
  } catch {
    return { status: 'crash', saved: null, total: null };
  }
  const saved = savedOrders.get(id);
  return {
    status: out.code,
    saved: saved ? saved.items.map(item => item.sku) : null,
    total: saved ? service.total(id) : null,
  };
});
console.log(JSON.stringify(outcomes));
