import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useEffect, useMemo, useState } from '../src/stubs/react';

describe('useState stub', () => {
  test('returns the initial value and a setter', () => {
    const [value, setValue] = useState(3);
    assert.equal(value, 3);
    assert.equal(typeof setValue, 'function');
  });

  test('accepts null as an initial value', () => {
    const [value] = useState<string | null>(null);
    assert.equal(value, null);
  });

  test('the setter can be called without throwing', () => {
    const [, setValue] = useState('a');
    assert.doesNotThrow(() => setValue('b'));
  });
});

describe('useEffect stub', () => {
  test('runs the effect immediately', () => {
    let runs = 0;
    useEffect(() => {
      runs += 1;
    });
    assert.equal(runs, 1);
  });

  test('ignores the dependency list', () => {
    let runs = 0;
    useEffect(() => {
      runs += 1;
    }, [1, 2]);
    assert.equal(runs, 1);
  });
});

describe('useMemo stub', () => {
  test('returns the result of the factory', () => {
    assert.equal(useMemo(() => 6 * 7), 42);
  });

  test('calls the factory exactly once', () => {
    let calls = 0;
    useMemo(() => {
      calls += 1;
      return calls;
    }, []);
    assert.equal(calls, 1);
  });
});
