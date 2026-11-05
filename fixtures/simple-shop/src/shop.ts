import { getPrice } from './catalog';
import { getCustomerName } from './customers';
import { chargeCard } from './payment';
import { buildReceipt } from './receipt';
import { stockOf } from './stock';

export const placeOrder = (customerId: string, code: string, qty: number) => {
  if (stockOf(code) < qty) {
    return { ok: false, reason: 'out of stock' };
  }
  const charged = chargeCard(getPrice(code) * qty);
  const receipt = buildReceipt(getCustomerName(customerId), code);
  return { ok: true, charged, receipt };
};
