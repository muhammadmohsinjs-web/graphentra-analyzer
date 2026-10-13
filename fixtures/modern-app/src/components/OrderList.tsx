import { useState, useEffect } from '../stubs/react';
import { OrderRow } from './OrderRow';
import Summary from './Summary';
import type { Order } from '../types';

export const OrderList = ({ orders }: { orders: Order[] }) => {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (selected !== null) {
      console.log('selected', selected);
    }
  }, [selected]);

  const handleClear = () => setSelected(null);

  const renderRow = (order: Order) => (
    <OrderRow order={order} onSelect={setSelected} />
  );

  return (
    <div className="order-list">
      <button onClick={handleClear}>Clear</button>
      <ul>{orders.map(renderRow)}</ul>
      <Summary orders={orders} />
    </div>
  );
};
