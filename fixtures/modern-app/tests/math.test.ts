import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, orderTotal, sum } from '../src/utils/math';
import type { Order } from '../src/types';

describe('clamp', () => {
  test('returns n when it is inside the range', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  test('raises values below min to min', () => {
    assert.equal(clamp(-3, 0, 10), 0);
  });

  test('lowers values above max to max', () => {
    assert.equal(clamp(42, 0, 10), 10);
  });

  test('keeps values that sit exactly on a bound', () => {
    assert.equal(clamp(0, 0, 10), 0);
    assert.equal(clamp(10, 0, 10), 10);
  });
});

describe('sum', () => {
  test('returns 0 for an empty list', () => {
    assert.equal(sum([]), 0);
  });

  test('returns the value itself for a single element', () => {
    assert.equal(sum([7]), 7);
  });

  test('handles negative numbers', () => {
    assert.equal(sum([5, -2, -3]), 0);
  });
});

describe('orderTotal', () => {
  test('multiplies price by quantity and adds the lines', () => {
    const order: Order = {
      id: 'o1',
      items: [
        { sku: 'A-1', price: 2.5, qty: 4 },
        { sku: 'B-2', price: 1, qty: 1 },
      ],
    };
    assert.equal(orderTotal(order), 11);
  });

  test('returns 0 for an order with no items', () => {
    assert.equal(orderTotal({ id: 'empty', items: [] }), 0);
  });

  test('caps the total at 1,000,000', () => {
    const order: Order = { id: 'big', items: [{ sku: 'A-1', price: 600000, qty: 2 }] };
    assert.equal(orderTotal(order), 1000000);
  });

  test('does not cap totals below the limit', () => {
    const order: Order = { id: 'almost', items: [{ sku: 'A-1', price: 999999, qty: 1 }] };
    assert.equal(orderTotal(order), 999999);
  });
});
