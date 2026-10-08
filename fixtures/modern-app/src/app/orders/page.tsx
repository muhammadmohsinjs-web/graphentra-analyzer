import type { Order } from '../../types';
import { OrderList } from '../../components/OrderList';
import Summary from '../../components/Summary';

export default async function OrdersPage() {
  const loadOrders = async (): Promise<Order[]> => {
    return [{ id: 'o1', items: [{ sku: 'A-1', price: 10, qty: 2 }] }];
  };
  const orders = await loadOrders();
  return (
    <main>
      <OrderList orders={orders} />
      <Summary />
    </main>
  );
}
