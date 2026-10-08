import { useMemo } from '../stubs/react';
import { formatPrice } from '../utils/format';
import type { Order } from '../types';

const orderTotal = (order: Order): number =>
  order.items.reduce((sum, it) => sum + it.price * it.qty, 0);

export function OrderRow({ order, onSelect }: { order: Order; onSelect: (id: string) => void }) {
  const total = useMemo(() => orderTotal(order), [order]);
  return (
    <li className="order-row" onClick={() => onSelect(order.id)}>
      <span>{order.id}</span>
      <span>{formatPrice(total)}</span>
    </li>
  );
}
