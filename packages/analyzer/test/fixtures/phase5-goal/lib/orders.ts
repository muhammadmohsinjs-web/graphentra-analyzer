export interface Order { id: number; amount: number }

export function createOrder(amount: number): Order {
  if (amount < 1) throw new Error('amount too small');
  return { id: 1, amount };
}
