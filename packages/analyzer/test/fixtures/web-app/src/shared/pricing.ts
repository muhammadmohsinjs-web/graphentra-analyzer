export const MIN_ORDER_AMOUNT = 1;
export const ROUTES = {
  cart: '/cart',
  checkout: '/checkout',
};

export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function orderTotal(items: Array<{ price: number; quantity: number }>): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
