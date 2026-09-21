import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliOptions, resolveCliComparison } from '../src/cli-options';

test('parses the GitHub Actions invocation', () => {
  assert.deepEqual(
    parseCliOptions([
      '--target',
      '/workspace/app',
      '--base',
      'base-sha',
      '--head',
      'head-sha',
      '--report',
      '/tmp/graphentra-report.md',
    ], { reporting: true }),
    {
      target: '/workspace/app',
      base: 'base-sha',
      head: 'head-sha',
      report: '/tmp/graphentra-report.md',
      workingTree: false,
    },
  );
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
  assert.deepEqual(
    parseCliOptions([
      '--target',
      '/workspace/app',
      '--base',
      'main',
      '--working-tree',
    ]),
    {
      target: '/workspace/app',
      base: 'main',
      head: undefined,
      report: undefined,
      workingTree: true,
    },
  );
});

test('parses custom --output filename', () => {
  assert.deepEqual(
    parseCliOptions([
      '--target',
      '/workspace/app',
      '--output',
      '/artifacts/graphentra',
      '--working-tree',
    ]),
    {
      target: '/workspace/app',
      base: undefined,
      head: undefined,
      report: undefined,
      output: '/artifacts/graphentra',
      workingTree: true,
    },
  );
});

test('rejects incomplete and ambiguous invocations', () => {
  assert.throws(() => parseCliOptions([]), /Repository path is required/);
  assert.throws(
    () => parseCliOptions(['--target', '/one', '/two']),
    /either --target or a positional path/,
  );
  assert.throws(
    () => parseCliOptions(['--target', '/one', '--base', 'main']),
    /--base and --head/,
  );
  assert.throws(() => parseCliOptions(['--unknown', 'value']), /Unknown option/);
  assert.throws(
    () => parseCliOptions(['/workspace/app', '--working-tree', '--head', 'HEAD']),
    /cannot be used with --head/,
  );
});

test('strict parsing rejects report, short unknown flags, blanks and option-value help', () => {
  for (const args of [['--report', 'qa.md'], ['-x'], ['--target', ' '], ['--target', '--help'], ['--help', '--help']]) {
    assert.throws(() => parseCliOptions(args));
  }
  assert.equal(parseCliOptions(['--target=--help']).help, undefined);
});

test('comparison resolves explicit flags first and rejects incomplete environment pairs', () => {
  assert.deepEqual(resolveCliComparison({ workingTree: false, base: 'a', head: 'b' }, { BASE_SHA: 'bad' }), { mode: 'commit', base: 'a', head: 'b' });
  assert.deepEqual(resolveCliComparison({ workingTree: true }, { BASE_SHA: 'bad' }), { mode: 'working-tree', base: 'HEAD' });
  for (const env of [{ BASE_SHA: 'a' }, { HEAD_SHA: 'b' }, { BASE_SHA: '', HEAD_SHA: 'b' }]) {
    assert.throws(() => resolveCliComparison({ workingTree: false }, env));
  }
});
