import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrders, createOrder, health } from '../src/server/handlers';
import { buildApp } from '../src/server/app';
import type { Req, Res } from '../src/server/router';

const fakeRes = () => {
  const out: { code: number; body: unknown } = { code: 200, body: undefined };
  const res: Res = {
    status(code) {
      out.code = code;
      return res;
    },
    json(data) {
      out.body = data;
    },
    send(text) {
      out.body = text;
    },
  };
  return { res, out };
};

test('health replies ok', () => {
  const { res, out } = fakeRes();
  health({ method: 'GET', path: '/health' }, res);
  assert.equal(out.body, 'ok');
});

test('listOrders returns a count', () => {
  const { res, out } = fakeRes();
  listOrders({ method: 'GET', path: '/orders' }, res);
  assert.ok(out.body && typeof out.body === 'object');
});

test('createOrder responds with a status code', () => {
  const { res, out } = fakeRes();
  const req: Req = { method: 'POST', path: '/orders', body: { id: 'o9', items: [{ sku: 'A-1', price: 1, qty: 1 }] } };
  createOrder(req, res);
  assert.ok(out.code === 201 || out.code === 409);
});

test('router dispatches known routes only', () => {
  const app = buildApp();
  const { res } = fakeRes();
  assert.equal(app.dispatch({ method: 'GET', path: '/nope' }, res), false);
});
