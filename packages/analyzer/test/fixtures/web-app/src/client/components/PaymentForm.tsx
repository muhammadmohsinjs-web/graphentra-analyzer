import { formatPrice } from '../../shared/pricing';

export const PaymentForm = ({ total }: { total: number }) => (
  <form>
    <label htmlFor="card">Card number</label>
    <input id="card" placeholder="Card number" />
    <p>Amount due {formatPrice(total)}</p>
  </form>
);
