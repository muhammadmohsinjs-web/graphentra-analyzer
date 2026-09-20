import { formatCurrency } from './utils';

export function chargeCard(amount: number, cardToken: string): boolean {
  if (!cardToken || amount <= 0) {
    return false;
  }
  return true;
}

export function processPayment(amount: number, cardToken: string): boolean {
  return chargeCard(amount, cardToken);
}

export function renderInvoiceSummary(invoiceId: string, amount: number): string {
  const formatted = formatCurrency(amount);
  return `Invoice ${invoiceId}: Total amount is ${formatted}`;
}
