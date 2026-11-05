import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import slugify, { formatPrice, pad, titleCase } from '../src/utils/format';

describe('formatPrice', () => {
  test('formats with a dollar sign and two decimals', () => {
    assert.equal(formatPrice(3.5), '$3.50');
    assert.equal(formatPrice(0), '$0.00');
  });

  test('rounds to the nearest cent', () => {
    assert.equal(formatPrice(2.499), '$2.50');
    assert.equal(formatPrice(2.494), '$2.49');
  });

  test('does not add thousands separators', () => {
    assert.equal(formatPrice(1234.5), '$1234.50');
  });
});

describe('pad', () => {
  test('pads on the left up to the width', () => {
    assert.equal(pad('ab', 5), '   ab');
  });

  test('returns the input unchanged when it is already wide enough', () => {
    assert.equal(pad('abcdef', 3), 'abcdef');
    assert.equal(pad('abc', 3), 'abc');
  });

  test('pads an empty string to the width', () => {
    assert.equal(pad('', 3), '   ');
  });
});

describe('slugify', () => {
  test('lowercases, trims and joins words with hyphens', () => {
    assert.equal(slugify('  Hello World  '), 'hello-world');
  });

  test('collapses runs of punctuation and spaces into one hyphen', () => {
    assert.equal(slugify('Hello,   big -- world!'), 'hello-big-world');
  });

  test('strips leading and trailing hyphens', () => {
    assert.equal(slugify('---a---'), 'a');
  });

  test('drops non-ASCII letters', () => {
    assert.equal(slugify('Café'), 'caf');
  });

  test('returns an empty string when there are no alphanumerics', () => {
    assert.equal(slugify('!!!'), '');
  });
});

describe('titleCase', () => {
  test('capitalizes each word and lowercases the rest', () => {
    assert.equal(titleCase('hELLO wORLD'), 'Hello World');
  });

  test('handles a single word', () => {
    assert.equal(titleCase('graphentra'), 'Graphentra');
  });

  test('returns an empty string unchanged', () => {
    assert.equal(titleCase(''), '');
  });
});
