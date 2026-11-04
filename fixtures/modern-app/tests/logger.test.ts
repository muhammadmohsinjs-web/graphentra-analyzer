import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../src/services/logger';
import { newLogger } from './support/factories';

// `lines` is private; reading it is the only way to check the formatted output.
const linesOf = (logger: Logger): string[] => (logger as unknown as { lines: string[] }).lines;

describe('Logger', () => {
  test('starts with no lines', () => {
    assert.equal(newLogger('x').lineCount, 0);
  });

  test('counts every info call', () => {
    const logger = newLogger('x');
    logger.info('one');
    logger.info('two');
    assert.equal(logger.lineCount, 2);
  });

  test('formats each line with the prefix in brackets', () => {
    const logger = newLogger('app');
    logger.info('started');
    assert.deepEqual(linesOf(logger), ['[app] started']);
  });

  test('Logger.create uses the default prefix', () => {
    const logger = Logger.create();
    logger.info('hello');
    assert.deepEqual(linesOf(logger), ['[default] hello']);
  });

  test('instances do not share their lines', () => {
    const a = newLogger('a');
    const b = newLogger('b');
    a.info('only in a');
    assert.equal(a.lineCount, 1);
    assert.equal(b.lineCount, 0);
  });
});
