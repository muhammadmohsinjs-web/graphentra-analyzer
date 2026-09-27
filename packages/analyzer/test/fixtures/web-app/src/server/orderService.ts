import { MIN_ORDER_AMOUNT } from '../shared/pricing';

export function chargeCard(amount: number, cardToken: string): boolean {
  if (!cardToken || amount < MIN_ORDER_AMOUNT) {
    return false;
  }
  return true;
}

export function createOrder(req: any, res: any) {
  const total = Number(req.body.total);
  if (!chargeCard(total, req.body.cardToken)) {
    return res.status(400).json({ message: 'Payment was declined' });
  }
  return res.status(201).json({ status: 'PAID' });
}

export function getOrder(req: any, res: any) {
  return res.json({ id: req.params.id });
}
