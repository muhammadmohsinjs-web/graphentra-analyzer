import { Link } from 'react-router-dom';
import { ROUTES } from '../../shared/pricing';

export const CartPage = () => (
  <main>
    <h1>Your cart</h1>
    <Link to={ROUTES.checkout}>Proceed to checkout</Link>
  </main>
);
