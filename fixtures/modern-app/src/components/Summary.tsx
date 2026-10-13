import { useMemo } from '../stubs/react';
import { formatPrice } from '../utils/format';
import type { Order } from '../types';

const Summary = (props: { orders?: Order[] }) => {
  const count = useMemo(() => (props.orders ?? []).length, [props.orders]);
  return (
    <footer className="summary">
      <p>Orders: {count}</p>
      <p>Sample: {formatPrice(count * 10)}</p>
    </footer>
  );
};

export default Summary;
