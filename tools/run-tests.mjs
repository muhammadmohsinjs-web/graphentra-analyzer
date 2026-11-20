#!/usr/bin/env node
// Cross-platform test launcher: `node <path>/tools/run-tests.mjs test/*.test.ts ...` runs `tsx --test` on the matching files.
// On Windows (cmd.exe) the shell does not expand `*`, and Node 20's test runner does not expand patterns either, so CI on
// Node 20 + Windows found no tests. Patterns are expanded here (only `*` within the last path segment, which is all the
// package scripts use). Already-expanded paths (POSIX shells) pass through. A pattern that matches nothing is an error.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const patterns = process.argv.slice(2);
if (!patterns.length) {
  console.error('Usage: node tools/run-tests.mjs <file or dir/*.ext pattern>...');
  process.exit(2);
}

function expand(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized.includes('*')) return [normalized];
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  if (dir.includes('*')) throw new Error(`Only "*" in the file name is supported: ${pattern}`);
  const regex = new RegExp(`^${base.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => regex.test(name)).sort() : [];
  return names.map(name => path.posix.join(dir, name));
}

const files = [];
for (const pattern of patterns) {
  const matched = expand(pattern);
  if (!matched.length) {
    console.error(`Could not find any test file matching '${pattern}' in ${process.cwd()}`);
    process.exit(1);
  }
  files.push(...matched);
}

// Run the tsx CLI with the current Node, so no shell or .cmd shim is involved on Windows. Resolve tsx from the package
// being tested (the working directory), so a package copied out of the workspace uses its own install.
const tsxCli = createRequire(path.join(process.cwd(), 'package.json')).resolve('tsx/cli');
const result = spawnSync(process.execPath, [tsxCli, '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
