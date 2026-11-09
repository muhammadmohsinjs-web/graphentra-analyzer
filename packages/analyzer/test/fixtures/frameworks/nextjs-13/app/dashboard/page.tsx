import { listOrders } from '../../lib/orders';

export default function DashboardPage() {
  return `Orders: ${listOrders().length}`;
}
