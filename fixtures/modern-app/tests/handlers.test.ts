import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrders, createOrder, health, service } from '../src/server/handlers';
import { inventory } from '../src/services/inventory';
import type { Req } from '../src/server/router';
import { fakeRes } from './support/fake-res';

// The handlers share one module-level service and inventory, so each test resets stock
// and uses its own order ids.
beforeEach(() => {
  inventory.stock.clear();
  inventory.stock.set('A-1', 10);
});

describe('health', () => {
  test('replies ok with status 200', () => {
    const { res, out } = fakeRes();
    health({ method: 'GET', path: '/health' }, res);
    assert.equal(out.body, 'ok');
    assert.equal(out.code, 200);
  });
});

describe('listOrders', () => {
  test('returns the current count as an object', () => {
    const { res, out } = fakeRes();
    listOrders({ method: 'GET', path: '/orders' }, res);
    assert.deepEqual(out.body, { count: service.count });
  });

  test('reflects orders created through createOrder', () => {
    const before = service.count;
    createOrder(
      { method: 'POST', path: '/orders', body: { id: 'o-list-1', items: [{ sku: 'A-1', price: 1, qty: 1 }] } },
      fakeRes().res,
    );
    const { res, out } = fakeRes();
    listOrders({ method: 'GET', path: '/orders' }, res);
    assert.deepEqual(out.body, { count: before + 1 });
  });
});

describe('createOrder', () => {
  test('responds 201 with the id, total and formatted total', () => {
    const { res, out } = fakeRes();
    const req: Req = {
      method: 'POST',
      path: '/orders',
      body: { id: 'o-create-1', items: [{ sku: 'A-1', price: 4, qty: 2 }] },
    };
    createOrder(req, res);
    assert.equal(out.code, 201);
    assert.deepEqual(out.body, { id: 'o-create-1', total: 8, formatted: '$8.00' });
  });

  test('stores the order so it can be priced later', () => {
    const { res } = fakeRes();
    createOrder(
      { method: 'POST', path: '/orders', body: { id: 'o-store-1', items: [{ sku: 'A-1', price: 3, qty: 1 }] } },
      res,
    );
    assert.equal(service.total('o-store-1'), '$3.00');
  });

  test('accepts a quantity equal to the stock on hand', () => {
    inventory.stock.set('A-1', 2);
    const { res, out } = fakeRes();
    createOrder(
      { method: 'POST', path: '/orders', body: { id: 'o-exact-1', items: [{ sku: 'A-1', price: 1, qty: 2 }] } },
      res,
    );
    assert.equal(out.code, 201);
  });

  test('responds 409 when a line exceeds the stock on hand', () => {
    inventory.stock.set('A-1', 1);
    const before = service.count;
    const { res, out } = fakeRes();
    createOrder(
      { method: 'POST', path: '/orders', body: { id: 'o-short-1', items: [{ sku: 'A-1', price: 1, qty: 2 }] } },
      res,
    );
    assert.equal(out.code, 409);
    assert.deepEqual(out.body, { error: 'out of stock' });
    assert.equal(service.count, before);
  });

  test('responds 409 for an unknown sku', () => {
    const { res, out } = fakeRes();
    createOrder(
      { method: 'POST', path: '/orders', body: { id: 'o-unknown-1', items: [{ sku: 'NOPE', price: 1, qty: 1 }] } },
      res,
    );
    assert.equal(out.code, 409);
  });

  test('rejects the whole order when any one line is out of stock', () => {
    const before = service.count;
    const { res, out } = fakeRes();
    createOrder(
      {
        method: 'POST',
        path: '/orders',
        body: {
          id: 'o-partial-1',
          items: [
            { sku: 'A-1', price: 1, qty: 1 },
            { sku: 'NOPE', price: 1, qty: 1 },
          ],
        },
      },
      res,
    );
    assert.equal(out.code, 409);
    assert.equal(service.count, before);
  });
});
