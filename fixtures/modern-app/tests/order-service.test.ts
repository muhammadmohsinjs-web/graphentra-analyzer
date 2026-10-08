import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService } from '../src/services/order-service';
import { orderTotal, sum } from '../src/utils/math';
import type { Order } from '../src/types';

const order: Order = { id: 'o1', items: [{ sku: 'A-1', price: 10, qty: 2 }, { sku: 'B-2', price: 5, qty: 1 }] };

test('orderTotal sums line items', () => {
  assert.equal(orderTotal(order), 25);
});

test('sum adds numbers', () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test('OrderService tracks added orders', () => {
  const svc = OrderService.create();
  const before = svc.count;
  svc.add(order);
  assert.equal(svc.count, before + 1);
  assert.equal(typeof svc.total('o1'), 'string');
});
