import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeId } from '../src/utils/ids';

const sequenceOf = (id: string): number => Number(id.split('-').pop());

describe('makeId', () => {
  test('prefixes the id and joins with a hyphen', () => {
    assert.match(makeId('ord'), /^ord-\d+$/);
  });

  test('returns a different id on every call', () => {
    assert.notEqual(makeId('x'), makeId('x'));
  });

  test('uses one shared sequence across prefixes', () => {
    const first = sequenceOf(makeId('a'));
    const second = sequenceOf(makeId('b'));
    assert.equal(second, first + 1);
  });
});
