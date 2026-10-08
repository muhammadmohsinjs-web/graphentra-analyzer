import { Order } from '../types';

// NOTE: an overloaded `clamp` (several signatures + one implementation) is deliberately NOT
// here: today's analyzer aborts with AMBIGUOUS_ENTITY_ID on duplicate function names, which
// would make every golden for this fixture an error. See README, "Known analyzer crash".
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export const sum = (xs: number[]) => {
  function add(a: number, b: number): number {
    return a + b;
  }
  let total = 0;
  for (const x of xs) {
    total = add(total, x);
  }
  return total;
};

export const orderTotal = (order: Order): number => {
  const lines = order.items.map((i) => i.price * i.qty);
  return clamp(sum(lines), 0, 1000000);
};
