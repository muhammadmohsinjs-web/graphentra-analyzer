import { listOrders } from '../lib/orders';

export default function LegacyOrders() {
  return `Orders: ${listOrders().length}`;
}
