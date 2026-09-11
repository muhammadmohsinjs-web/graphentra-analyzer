import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliOptions } from '../src/cli';

test('parses the GitHub Actions invocation', () => {
  assert.deepEqual(parseCliOptions([
    '--target', '/workspace/app',
    '--base', 'base-sha',
    '--head', 'head-sha',
    '--report', '/tmp/graphentra-report.md',
  ]), {
    target: '/workspace/app',
    base: 'base-sha',
    head: 'head-sha',
    report: '/tmp/graphentra-report.md',
  });
});

test('retains positional target and supports equals syntax', () => {
  assert.deepEqual(parseCliOptions(['/workspace/app', '--base=main', '--head=HEAD']), {
    target: '/workspace/app',
    base: 'main',
    head: 'HEAD',
    report: undefined,
  });
});

test('rejects incomplete and ambiguous invocations', () => {
  assert.throws(() => parseCliOptions([]), /Repository path is required/);
  assert.throws(() => parseCliOptions(['--target', '/one', '/two']), /either --target or a positional path/);
  assert.throws(() => parseCliOptions(['--target', '/one', '--base', 'main']), /--base and --head/);
  assert.throws(() => parseCliOptions(['--unknown', 'value']), /Unknown option/);
});
