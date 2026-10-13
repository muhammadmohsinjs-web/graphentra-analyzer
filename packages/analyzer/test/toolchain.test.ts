import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { PINNED_TYPESCRIPT_VERSION, toolchainDiagnostics } from '../src/index';

/** Toolchain pinning (P0-10): one exact parser version, and a warning when the loaded one differs. */
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Monorepo manifests that exist; the standalone distribution check copies only packages/analyzer. */
function workspaceManifests(): string[] {
  const manifests = ['package.json'];
  for (const group of ['packages', 'apps']) {
    const dir = path.join(REPO_ROOT, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) manifests.push(path.join(group, name, 'package.json'));
  }
  return manifests.filter(manifest => fs.existsSync(path.join(REPO_ROOT, manifest)));
}

test('toolchain: a different TypeScript version gives a TOOLCHAIN_VERSION_MISMATCH warning', () => {
  const diagnostics = toolchainDiagnostics('5.9.0');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'TOOLCHAIN_VERSION_MISMATCH');
  assert.equal(diagnostics[0].severity, 'warning');
  assert.match(diagnostics[0].message, /TypeScript 5\.9\.0 is loaded/);
  assert.match(diagnostics[0].message, new RegExp(`pinned to ${PINNED_TYPESCRIPT_VERSION.replace(/\./g, '\\.')}`));
});

test('toolchain: the pinned TypeScript version gives no warning', () => {
  assert.deepEqual(toolchainDiagnostics(PINNED_TYPESCRIPT_VERSION), []);
});

test('toolchain: the installed TypeScript is the pinned version', () => {
  assert.equal(ts.version, PINNED_TYPESCRIPT_VERSION);
  assert.deepEqual(toolchainDiagnostics(), []);
});

test('toolchain: every workspace manifest pins typescript to the exact pinned version', () => {
  const manifests = workspaceManifests();
  assert.ok(manifests.includes(path.join('packages', 'analyzer', 'package.json')));
  let pinned = 0;
  for (const manifest of manifests) {
    const json = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifest), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const range = json[field]?.typescript;
      if (range === undefined) continue;
      assert.equal(range, PINNED_TYPESCRIPT_VERSION, `${manifest} ${field}.typescript must be exactly ${PINNED_TYPESCRIPT_VERSION}`);
      pinned++;
    }
  }
  assert.ok(pinned > 0, 'expected at least one manifest to declare typescript');
});
