import { reserveStock } from './inventory';
import { processPayment } from './billing';
import { sendOrderConfirmation } from './notifications';
import { calculateOrderTotal } from './pricing';

export function submitOrder(
  cartId: string,
  sku: string,
  quantity: number,
  price: number,
  cardToken: string,
): boolean {
  const stockReserved = reserveStock(sku, quantity);
  if (!stockReserved) {
    return false;
  }

  const subtotal = price * quantity;
  const formattedTotal = calculateOrderTotal(subtotal, 0, 0.08);

  const paymentSuccess = processPayment(subtotal, cardToken);
  if (!paymentSuccess) {
    return false;
  }

  sendOrderConfirmation('customer@example.com', cartId, formattedTotal);
  return true;
}

export function handleCheckout(
  cartId: string,
  sku: string,
  quantity: number,
  price: number,
  cardToken: string,
): string {
  const success = submitOrder(cartId, sku, quantity, price, cardToken);
  return success ? `ORDER_PLACED:${cartId}` : 'ORDER_FAILED';
}
