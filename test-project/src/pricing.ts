import { formatCurrency } from './utils';

export function calculateTax(amount: number, taxRate: number): number {
  if (taxRate < 0 || taxRate > 1) {
    throw new Error('Invalid tax rate');
  }
  return amount * taxRate;
}

export function applyDiscount(subtotal: number, discountPercentage: number): number {
  if (discountPercentage <= 0) {
    return subtotal;
  }
  const discount = subtotal * (discountPercentage / 100);
  return Math.max(0, subtotal - discount);
}

export function calculateOrderTotal(subtotal: number, discountPercentage: number, taxRate: number): string {
  const discounted = applyDiscount(subtotal, discountPercentage);
  const tax = calculateTax(discounted, taxRate);
  const finalTotal = discounted + tax;
  return formatCurrency(finalTotal);
}
