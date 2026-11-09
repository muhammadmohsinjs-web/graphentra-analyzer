import { createOrder } from '../lib/orders';

export function seed(): void {
  createOrder(5);
}
