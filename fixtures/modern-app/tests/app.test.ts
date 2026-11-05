import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app';
import { inventory } from '../src/services/inventory';
import { fakeRes } from './support/fake-res';

beforeEach(() => {
  inventory.stock.clear();
  inventory.stock.set('A-1', 10);
  mock.method(console, 'log', () => {});
});

afterEach(() => {
  mock.restoreAll();
});

const loggedLines = (): unknown[] => (console.log as unknown as { mock: { calls: { arguments: unknown[] }[] } }).mock.calls.map((c) => c.arguments[0]);

describe('buildApp', () => {
  test('registers the three public routes in order', () => {
    const app = buildApp();
    assert.deepEqual(
      app.routes.map((r) => `${r.method} ${r.path}`),
      ['GET /orders', 'POST /orders', 'GET /health'],
    );
  });

  test('GET /health responds ok', () => {
    const app = buildApp();
    const { res, out } = fakeRes();
    assert.equal(app.dispatch({ method: 'GET', path: '/health' }, res), true);
    assert.equal(out.body, 'ok');
  });

  test('GET /orders responds with a count', () => {
    const app = buildApp();
    const { res, out } = fakeRes();
    assert.equal(app.dispatch({ method: 'GET', path: '/orders' }, res), true);
    assert.equal(typeof (out.body as { count: unknown }).count, 'number');
  });

  test('POST /orders creates an order when stock is available', () => {
    const app = buildApp();
    const { res, out } = fakeRes();
    app.dispatch(
      { method: 'POST', path: '/orders', body: { id: 'o-app-1', items: [{ sku: 'A-1', price: 2, qty: 1 }] } },
      res,
    );
    assert.equal(out.code, 201);
    assert.deepEqual(out.body, { id: 'o-app-1', total: 2, formatted: '$2.00' });
  });

  test('logs each request through the middleware', () => {
    const app = buildApp();
    const { res } = fakeRes();
    app.dispatch({ method: 'GET', path: '/health' }, res);
    assert.deepEqual(loggedLines(), ['GET /health']);
  });

  test('logs unknown routes too and reports them as unhandled', () => {
    const app = buildApp();
    const { res } = fakeRes();
    assert.equal(app.dispatch({ method: 'DELETE', path: '/orders' }, res), false);
    assert.deepEqual(loggedLines(), ['DELETE /orders']);
  });
});
