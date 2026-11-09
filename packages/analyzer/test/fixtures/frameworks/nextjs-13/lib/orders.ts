export interface Order { id: string; amount: number }

export function listOrders(): Order[] {
  return [{ id: 'o1', amount: 10 }];
}

export function createOrder(amount: number): Order {
  if (amount < 1) throw new Error('amount too small');
  return { id: 'o2', amount };
}

export function describeProduct(id: string): string {
  return `Product ${id}`;
}
