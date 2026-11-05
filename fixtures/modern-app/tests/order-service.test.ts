import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService, createDefaultService } from '../src/services/order-service';
import { Logger } from '../src/services/logger';
import { orderTotal, sum } from '../src/utils/math';
import { newLogger, newOrderService } from './support/factories';
import type { Order } from '../src/types';

// Totals 10*2 + 5*1 = 25.
const order: Order = { id: 'o1', items: [{ sku: 'A-1', price: 10, qty: 2 }, { sku: 'B-2', price: 5, qty: 1 }] };
const other: Order = { id: 'o2', items: [{ sku: 'C-3', price: 3, qty: 1 }] };

// `logger` is private; reading it is the only way to check what was recorded.
const loggerOf = (svc: OrderService): Logger => (svc as unknown as { logger: Logger }).logger;
const linesOf = (logger: Logger): string[] => (logger as unknown as { lines: string[] }).lines;

describe('orderTotal and sum (dependencies used by OrderService)', () => {
  test('orderTotal sums line items', () => {
    assert.equal(orderTotal(order), 25);
  });

  test('sum adds numbers', () => {
    assert.equal(sum([1, 2, 3]), 6);
  });
});

describe('OrderService.add and count', () => {
  test('starts empty', () => {
    assert.equal(OrderService.create().count, 0);
  });

  test('tracks added orders', () => {
    const svc = OrderService.create();
    const before = svc.count;
    svc.add(order);
    assert.equal(svc.count, before + 1);
  });

  test('counts distinct orders separately', () => {
    const svc = OrderService.create();
    svc.add(order);
    svc.add(other);
    assert.equal(svc.count, 2);
  });

  test('replaces an order that reuses an existing id', () => {
    const svc = OrderService.create();
    svc.add(order);
    svc.add({ id: 'o1', items: [{ sku: 'X', price: 1, qty: 1 }] });
    assert.equal(svc.count, 1);
    assert.equal(svc.total('o1'), '$1.00');
  });

  test('records one log line per added order', () => {
    const logger = newLogger('t');
    const svc = newOrderService(logger);
    svc.add(order);
    assert.deepEqual(linesOf(logger), ['[t] added order o1']);
  });
});

describe('OrderService.total', () => {
  test('returns the formatted total for a known order', () => {
    const svc = OrderService.create();
    svc.add(order);
    assert.equal(svc.total('o1'), '$25.00');
  });

  test('returns $0.00 for an unknown id', () => {
    assert.equal(OrderService.create().total('missing'), '$0.00');
  });
});

describe('factories', () => {
  test('OrderService.create returns an OrderService', () => {
    assert.ok(OrderService.create() instanceof OrderService);
  });

  test('createDefaultService logs with the "app" prefix', () => {
    const svc = createDefaultService();
    svc.add(order);
    assert.deepEqual(linesOf(loggerOf(svc)), ['[app] added order o1']);
  });
});
