import { submitOrder, handleCheckout } from '../src/orders';
import { calculateOrderTotal } from '../src/pricing';
import { validateZipCode } from '../src/standalone';

export function testSubmitOrder(): void {
  const result = submitOrder('cart_101', 'SKU_ABC', 2, 49.99, 'tok_visa');
  if (!result) {
    throw new Error('testSubmitOrder failed');
  }
}

export function testHandleCheckout(): void {
  const status = handleCheckout('cart_102', 'SKU_XYZ', 1, 99.00, 'tok_mastercard');
  if (!status.startsWith('ORDER_PLACED')) {
    throw new Error('testHandleCheckout failed');
  }
}

export function testOrderTotalCalculation(): void {
  const formatted = calculateOrderTotal(100, 10, 0.05);
  if (!formatted.includes('$')) {
    throw new Error('testOrderTotalCalculation failed');
  }
}

export function testStandaloneZipValidation(): void {
  const isValid = validateZipCode('94016');
  if (!isValid) {
    throw new Error('testStandaloneZipValidation failed');
  }
}
