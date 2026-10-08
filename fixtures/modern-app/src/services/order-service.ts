import type { Order } from '../types';
import { orderTotal } from '../utils/math';
import { formatPrice } from '../utils/format';
import { Logger } from './logger';

export class OrderService {
  private orders = new Map<string, Order>();

  constructor(private readonly logger: Logger) {}

  static create(): OrderService {
    return new OrderService(Logger.create());
  }

  add(order: Order): void {
    this.orders.set(order.id, order);
    this.record(order);
  }

  total(id: string): string {
    const order = this.orders.get(id);
    return order ? formatPrice(orderTotal(order)) : formatPrice(0);
  }

  get count(): number {
    return this.orders.size;
  }

  private record(order: Order): void {
    this.logger.info(`added order ${order.id}`);
  }
}

export const createDefaultService = () => new OrderService(new Logger('app'));
