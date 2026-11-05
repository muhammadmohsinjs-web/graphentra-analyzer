import './support/react-shim';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderRow } from '../src/components/OrderRow';
import { OrderList } from '../src/components/OrderList';
import Summary from '../src/components/Summary';
import type { Order } from '../src/types';
import type { El } from './support/react-shim';

const noop = () => {};

const twoLines: Order = { id: 'o1', items: [{ sku: 'A-1', price: 10, qty: 2 }, { sku: 'B-2', price: 5, qty: 1 }] };
const second: Order = { id: 'o2', items: [{ sku: 'C-3', price: 3, qty: 1 }] };

const render = (el: unknown): El => el as El;
const propsOf = (el: El): Record<string, any> => el.p as Record<string, any>;

describe('OrderRow', () => {
  test('renders an li with the order-row class', () => {
    const el = render(OrderRow({ order: twoLines, onSelect: noop }));
    assert.equal(el.t, 'li');
    assert.equal(propsOf(el).className, 'order-row');
  });

  test('shows the order id and its formatted total', () => {
    const el = render(OrderRow({ order: twoLines, onSelect: noop }));
    const [idSpan, totalSpan] = el.c as El[];
    assert.deepEqual(idSpan.c, ['o1']);
    assert.deepEqual(totalSpan.c, ['$25.00']);
  });

  test('shows $0.00 for an order with no items', () => {
    const el = render(OrderRow({ order: { id: 'empty', items: [] }, onSelect: noop }));
    const totalSpan = (el.c as El[])[1];
    assert.deepEqual(totalSpan.c, ['$0.00']);
  });

  test('calls onSelect with the order id when clicked', () => {
    const picked: string[] = [];
    const el = render(OrderRow({ order: second, onSelect: (id) => picked.push(id) }));
    propsOf(el).onClick();
    assert.deepEqual(picked, ['o2']);
  });
});

describe('OrderList', () => {
  test('renders a container with a Clear button, the rows and a summary', () => {
    const el = render(OrderList({ orders: [twoLines, second] }));
    assert.equal(el.t, 'div');
    assert.equal(propsOf(el).className, 'order-list');

    const [button, list, summary] = el.c as El[];
    assert.equal(button.t, 'button');
    assert.deepEqual(button.c, ['Clear']);
    assert.equal(list.t, 'ul');
    assert.equal(summary.t, Summary);
  });

  test('renders one OrderRow per order, in order', () => {
    const el = render(OrderList({ orders: [twoLines, second] }));
    const list = (el.c as El[])[1];
    assert.equal(list.c.length, 2);
    assert.equal((list.c[0] as El).t, OrderRow);
    assert.equal((list.c[1] as El).t, OrderRow);
    assert.equal(propsOf(list.c[0] as El).order, twoLines);
    assert.equal(propsOf(list.c[1] as El).order, second);
  });

  test('renders no rows for an empty list', () => {
    const el = render(OrderList({ orders: [] }));
    assert.equal(((el.c as El[])[1]).c.length, 0);
  });

  test('passes the orders to the summary', () => {
    const el = render(OrderList({ orders: [twoLines] }));
    const summary = (el.c as El[])[2];
    assert.deepEqual(propsOf(summary).orders, [twoLines]);
  });

  test('the Clear button handler runs without throwing', () => {
    const el = render(OrderList({ orders: [twoLines] }));
    const button = (el.c as El[])[0];
    assert.doesNotThrow(() => propsOf(button).onClick());
  });
});

describe('Summary', () => {
  test('shows the order count and a sample price of 10 per order', () => {
    const el = render(Summary({ orders: [twoLines, second] }));
    assert.equal(el.t, 'footer');
    const [countP, sampleP] = el.c as El[];
    assert.deepEqual(countP.c, ['Orders: ', 2]);
    assert.deepEqual(sampleP.c, ['Sample: ', '$20.00']);
  });

  test('defaults to zero orders when no list is given', () => {
    const el = render(Summary({}));
    const [countP, sampleP] = el.c as El[];
    assert.deepEqual(countP.c, ['Orders: ', 0]);
    assert.deepEqual(sampleP.c, ['Sample: ', '$0.00']);
  });
});
