import './support/react-shim';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import OrdersPage from '../src/app/orders/page';
import { OrderList } from '../src/components/OrderList';
import Summary from '../src/components/Summary';
import type { El } from './support/react-shim';

describe('OrdersPage', () => {
  test('renders a main element holding the list and the summary', async () => {
    const el = (await OrdersPage()) as unknown as El;
    assert.equal(el.t, 'main');
    const [list, summary] = el.c as El[];
    assert.equal(list.t, OrderList);
    assert.equal(summary.t, Summary);
  });

  test('loads the orders and passes them to the list', async () => {
    const el = (await OrdersPage()) as unknown as El;
    const list = (el.c as El[])[0];
    assert.deepEqual(list.p, {
      orders: [{ id: 'o1', items: [{ sku: 'A-1', price: 10, qty: 2 }] }],
    });
  });
});
