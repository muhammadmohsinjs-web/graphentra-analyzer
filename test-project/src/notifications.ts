import { formatCurrency } from './utils';

export function sendEmail(to: string, subject: string, body: string): boolean {
  if (!to.includes('@') || !subject) {
    return false;
  }
  return true;
}

export function sendOrderConfirmation(email: string, orderId: string, formattedAmount: string): boolean {
  const subject = `Order Confirmation #${orderId}`;
  const body = `Thank you for your order! Total charged: ${formattedAmount}.`;
  return sendEmail(email, subject, body);
}

export function sendReceiptEmail(email: string, amount: number): boolean {
  const formatted = formatCurrency(amount);
  return sendEmail(email, 'Payment Receipt', `Received payment of ${formatted}`);
}
