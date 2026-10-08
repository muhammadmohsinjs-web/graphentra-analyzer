import type { Handler } from './router';
import type { Order } from '../types';
import { OrderService, createDefaultService } from '../services/order-service';
import { orderTotal } from '../utils/math';
import { checkStock } from '../services/inventory';

export const service: OrderService = createDefaultService();

export const listOrders: Handler = (_req, res) => {
  res.json({ count: service.count });
};

export const createOrder: Handler = (req, res) => {
  const order = req.body as Order;
  const inStock = order.items.every((i) => checkStock(i.sku) >= i.qty);
  if (!inStock) {
    res.status(409).json({ error: 'out of stock' });
    return;
  }
  service.add(order);
  res.status(201).json({ id: order.id, total: orderTotal(order), formatted: service.total(order.id) });
};

export const health = function (_req: Parameters<Handler>[0], res: Parameters<Handler>[1]): void {
  res.send('ok');
};
