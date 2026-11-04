import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inventory, checkStock } from '../src/services/inventory';

beforeEach(() => {
  inventory.stock.clear();
});

describe('checkStock', () => {
  test('returns 0 for an unknown sku', () => {
    assert.equal(checkStock('NOPE'), 0);
  });

  test('returns the stored quantity', () => {
    inventory.stock.set('A-1', 4);
    assert.equal(checkStock('A-1'), 4);
  });
});

describe('inventory.reserve', () => {
  test('subtracts the quantity and returns what is left', () => {
    inventory.stock.set('A-1', 5);
    assert.equal(inventory.reserve('A-1', 2), 3);
    assert.equal(checkStock('A-1'), 3);
  });

  test('never goes below zero', () => {
    inventory.stock.set('A-1', 1);
    assert.equal(inventory.reserve('A-1', 10), 0);
    assert.equal(checkStock('A-1'), 0);
  });

  test('treats an unknown sku as zero stock', () => {
    assert.equal(inventory.reserve('Z-9', 1), 0);
    assert.equal(inventory.stock.has('Z-9'), true);
  });
});

describe('inventory.release', () => {
  test('clears the sku so it reads as zero stock', () => {
    inventory.stock.set('A-1', 5);
    inventory.release('A-1');
    assert.equal(checkStock('A-1'), 0);
  });

  test('stores zero rather than removing the entry', () => {
    inventory.stock.set('A-1', 5);
    assert.equal(inventory.release('A-1'), 0);
    assert.equal(inventory.stock.get('A-1'), 0);
  });
});
