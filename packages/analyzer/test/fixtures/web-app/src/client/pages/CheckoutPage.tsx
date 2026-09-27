import { useNavigate } from 'react-router-dom';
import { placeOrder } from '../api';
import { PaymentForm } from '../components/PaymentForm';

export function CheckoutPage() {
  const navigate = useNavigate();
  const submit = async () => {
    if (await placeOrder('cart-1', 'tok_visa')) navigate('/orders');
  };
  return (
    <main>
      <h1>Checkout</h1>
      <PaymentForm total={42} />
      <button onClick={submit}>Place order</button>
    </main>
  );
}
