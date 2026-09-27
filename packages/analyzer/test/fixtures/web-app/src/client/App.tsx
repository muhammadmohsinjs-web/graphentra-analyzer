import { Routes, Route, Link } from 'react-router-dom';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';

const menu = [
  { label: 'Catalog', href: '/' },
  { label: 'Your cart', href: '/cart' },
];

export function OrdersPage() {
  return <h1>Order history</h1>;
}

export function App() {
  return (
    <div>
      <nav>
        {menu.map(item => <Link key={item.href} to={item.href}>{item.label}</Link>)}
      </nav>
      <Routes>
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
        <Route path="/orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
      </Routes>
    </div>
  );
}

function RequireAuth({ children }: { children: unknown }) {
  return children;
}
