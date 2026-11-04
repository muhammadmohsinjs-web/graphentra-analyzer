import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/server/router';
import type { Handler, Req } from '../src/server/router';
import { fakeRes } from './support/fake-res';

const noop: Handler = () => {};

describe('Router registration', () => {
  test('records GET and POST routes with their methods', () => {
    const router = new Router().get('/a', noop).post('/b', noop);
    assert.deepEqual(
      router.routes.map((r) => [r.method, r.path]),
      [['GET', '/a'], ['POST', '/b']],
    );
  });

  test('get, post and use return the router for chaining', () => {
    const router = new Router();
    assert.equal(router.get('/a', noop), router);
    assert.equal(router.post('/a', noop), router);
    assert.equal(router.use(noop), router);
  });

  test('use records middleware', () => {
    const router = new Router().use(noop).use(noop);
    assert.equal(router.middleware.length, 2);
  });
});

describe('Router.dispatch', () => {
  test('calls the matching handler and returns true', () => {
    const seen: Req[] = [];
    const router = new Router().get('/orders', (req) => {
      seen.push(req);
    });
    const { res } = fakeRes();

    assert.equal(router.dispatch({ method: 'GET', path: '/orders' }, res), true);
    assert.deepEqual(seen, [{ method: 'GET', path: '/orders' }]);
  });

  test('matches on method as well as path', () => {
    const seen: Req[] = [];
    const router = new Router().get('/orders', (req) => {
      seen.push(req);
    });
    const { res } = fakeRes();

    assert.equal(router.dispatch({ method: 'POST', path: '/orders' }, res), false);
    assert.equal(seen.length, 0);
  });

  test('returns false and calls nothing for an unknown path', () => {
    const seen: Req[] = [];
    const router = new Router().get('/orders', (req) => {
      seen.push(req);
    });
    const { res } = fakeRes();

    assert.equal(router.dispatch({ method: 'GET', path: '/nope' }, res), false);
    assert.equal(seen.length, 0);
  });

  test('matches paths exactly, so a longer path does not match', () => {
    const router = new Router().get('/orders', noop);
    const { res } = fakeRes();
    assert.equal(router.dispatch({ method: 'GET', path: '/orders/1' }, res), false);
    assert.equal(router.dispatch({ method: 'GET', path: '/orders?x=1' }, res), false);
  });

  test('uses the first registered route when several match', () => {
    const called: string[] = [];
    const router = new Router()
      .get('/x', () => called.push('first'))
      .get('/x', () => called.push('second'));
    const { res } = fakeRes();

    router.dispatch({ method: 'GET', path: '/x' }, res);
    assert.deepEqual(called, ['first']);
  });

  test('runs middleware before the route handler, in registration order', () => {
    const order: string[] = [];
    const router = new Router()
      .use(() => order.push('mw1'))
      .use(() => order.push('mw2'))
      .get('/x', () => order.push('route'));
    const { res } = fakeRes();

    router.dispatch({ method: 'GET', path: '/x' }, res);
    assert.deepEqual(order, ['mw1', 'mw2', 'route']);
  });

  test('runs middleware even when no route matches', () => {
    let ran = false;
    const router = new Router().use(() => {
      ran = true;
    });
    const { res } = fakeRes();

    assert.equal(router.dispatch({ method: 'GET', path: '/missing' }, res), false);
    assert.equal(ran, true);
  });
});
