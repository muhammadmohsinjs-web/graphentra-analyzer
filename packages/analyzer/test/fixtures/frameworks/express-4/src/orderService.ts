export function placeOrder(amount: number): { id: string; amount: number } {
  if (amount < 1) throw new Error('amount too small');
  return { id: 'o1', amount };
}

export function findOrder(id: string): { id: string } {
  return { id };
}
