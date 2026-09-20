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
    workingTree: false,
  });
});

test('retains positional target and supports equals syntax', () => {
  assert.deepEqual(parseCliOptions(['/workspace/app', '--base=main', '--head=HEAD']), {
    target: '/workspace/app',
    base: 'main',
    head: 'HEAD',
    report: undefined,
    workingTree: false,
  });
});

test('parses working-tree comparison against HEAD', () => {
  assert.deepEqual(parseCliOptions(['/workspace/app', '--working-tree']), {
    target: '/workspace/app',
    base: undefined,
    head: undefined,
    report: undefined,
    workingTree: true,
  });
});

test('allows --base with --working-tree', () => {
  assert.deepEqual(parseCliOptions(['--target', '/workspace/app', '--base', 'main', '--working-tree']), {
    target: '/workspace/app',
    base: 'main',
    head: undefined,
    report: undefined,
    workingTree: true,
  });
});

test('rejects incomplete and ambiguous invocations', () => {
  assert.throws(() => parseCliOptions([]), /Repository path is required/);
  assert.throws(() => parseCliOptions(['--target', '/one', '/two']), /either --target or a positional path/);
  assert.throws(() => parseCliOptions(['--target', '/one', '--base', 'main']), /--base and --head/);
  assert.throws(() => parseCliOptions(['--unknown', 'value']), /Unknown option/);
  assert.throws(() => parseCliOptions(['/workspace/app', '--working-tree', '--head', 'HEAD']), /cannot be used with --head/);
});
