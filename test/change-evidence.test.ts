import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractEntityChange, getFunctionRanges, parseGitDiff } from '../src/change-evidence';

const header = 'diff --git a/src/service.ts b/src/service.ts\n--- a/src/service.ts\n+++ b/src/service.ts\n';

test('separate hunks isolate getCatalog line 16 from checkout line 150', () => {
  const [file] = parseGitDiff(header + `@@ -16 +16 @@ unrelated heading checkout
-} else if (prod.stock <= 5) {
+} else if (prod.stock <= 10) {
@@ -150 +150 @@ getCatalog
-if (cart.items.length === 0) {
+if (cart.items.length === 50) {`);
  const catalog = { name: 'getCatalog', startLine: 10, endLine: 30 };
  const checkout = { name: 'checkout', startLine: 140, endLine: 170 };
  const catalogChange = extractEntityChange(file, catalog, catalog)!;
  const checkoutChange = extractEntityChange(file, checkout, checkout)!;
  assert.deepEqual(catalogChange.changedLines, [16]);
  assert.deepEqual(catalogChange.removedCode, ['} else if (prod.stock <= 5) {']);
  assert.deepEqual(catalogChange.addedCode, ['} else if (prod.stock <= 10) {']);
  assert.doesNotMatch(JSON.stringify(catalogChange), /cart|checkout|150/);
  assert.deepEqual(checkoutChange.changedLines, [150]);
  assert.deepEqual(checkoutChange.removedCode, ['if (cart.items.length === 0) {']);
  assert.deepEqual(checkoutChange.addedCode, ['if (cart.items.length === 50) {']);
  assert.doesNotMatch(JSON.stringify(checkoutChange), /stock|getCatalog|16/);
});

test('one shared hunk clips neighboring functions and their unchanged context', () => {
  const before = 'function getCatalog() {\n  return stock <= 5;\n}\nfunction checkout() {\n  return cart.items.length === 0;\n}';
  const after = before.replace('<= 5', '<= 10').replace('=== 0', '=== 50');
  const [file] = parseGitDiff(header + `@@ -1,6 +1,6 @@
 function getCatalog() {
-  return stock <= 5;
+  return stock <= 10;
 }
 function checkout() {
-  return cart.items.length === 0;
+  return cart.items.length === 50;
 }`);
  const old = getFunctionRanges(file.file, before);
  const current = getFunctionRanges(file.file, after);
  const catalog = extractEntityChange(file, current[0], old[0])!;
  const checkout = extractEntityChange(file, current[1], old[1])!;
  assert.equal(catalog.diff, '--- a/src/service.ts\n+++ b/src/service.ts\n@@ -1,3 +1,3 @@\n function getCatalog() {\n-  return stock <= 5;\n+  return stock <= 10;\n }');
  assert.doesNotMatch(JSON.stringify(catalog), /checkout|cart/);
  assert.doesNotMatch(JSON.stringify(checkout), /getCatalog|stock/);
});

test('old coordinates attribute a deletion after an earlier insertion shifts function lines', () => {
  const [file] = parseGitDiff(header + `@@ -1,0 +2,2 @@
+const unrelatedA = 1;
+const unrelatedB = 2;
@@ -10,4 +12,3 @@
 function checkout() {
-  rejectEmptyCart();
   charge();
 }`);
  const change = extractEntityChange(file,
    { name: 'checkout', startLine: 12, endLine: 14 },
    { name: 'checkout', startLine: 10, endLine: 13 })!;
  assert.deepEqual(change.changedLines, [13]);
  assert.deepEqual(change.addedCode, []);
  assert.deepEqual(change.removedCode, ['  rejectEmptyCart();']);
  assert.doesNotMatch(change.diff, /unrelated/);
  assert.match(change.diff, /@@ -10,4 \+12,3 @@/);
});

test('deleting a whole function does not mark its surviving neighbor changed', () => {
  const [file] = parseGitDiff(header + `@@ -1,4 +1 @@
-function removed() {
-  checkout();
-}
 function checkout() {}`);
  assert.equal(extractEntityChange(file,
    { name: 'checkout', startLine: 1, endLine: 1 },
    { name: 'checkout', startLine: 4, endLine: 4 }), undefined);
});

test('a deletion outside the function cannot contaminate an adjacent replacement', () => {
  const [file] = parseGitDiff(header + `@@ -1,5 +1,4 @@
-const unrelatedSecret = 50;
 function getCatalog() {
-  return stock <= 5;
+  return stock <= 10;
 }
 function checkout() {}`);
  const change = extractEntityChange(file,
    { name: 'getCatalog', startLine: 1, endLine: 3 },
    { name: 'getCatalog', startLine: 2, endLine: 4 })!;
  assert.deepEqual(change.removedCode, ['  return stock <= 5;']);
  assert.deepEqual(change.changedLines, [2]);
  assert.doesNotMatch(change.diff, /unrelatedSecret|checkout/);
});

test('new files and zero-count insertion hunks retain only each new function', () => {
  const [file] = parseGitDiff(`diff --git a/src/service.ts b/src/service.ts
--- /dev/null
+++ b/src/service.ts
@@ -0,0 +1,2 @@
+function getCatalog() { return 10; }
+function checkout() { return 50; }`);
  const change = extractEntityChange(file, { name: 'getCatalog', startLine: 1, endLine: 1 }, undefined)!;
  assert.deepEqual(change.changedLines, [1]);
  assert.deepEqual(change.removedCode, []);
  assert.match(change.diff, /@@ -0,0 \+1,1 @@/);
  assert.doesNotMatch(change.diff, /checkout|50/);
});

test('header-like changed code is not mistaken for file metadata', () => {
  const [file] = parseGitDiff(header + '@@ -2 +2 @@\n--- a/value;\n+++ b/value;');
  const range = { name: 'update', startLine: 1, endLine: 3 };
  const change = extractEntityChange(file, range, range)!;
  assert.deepEqual(change.removedCode, ['-- a/value;']);
  assert.deepEqual(change.addedCode, ['++ b/value;']);
  assert.equal(file.file, 'src/service.ts');
});

test('zero-context deletion uses the next new line and retains correct patch coordinates', () => {
  const [file] = parseGitDiff(header + '@@ -3 +2,0 @@\n-  rejectEmptyCart();');
  const change = extractEntityChange(file,
    { name: 'checkout', startLine: 1, endLine: 4 },
    { name: 'checkout', startLine: 1, endLine: 5 })!;
  assert.deepEqual(change.changedLines, [3]);
  assert.match(change.diff, /@@ -3,1 \+2,0 @@/);
});

test('replacement blocks spanning adjacent functions retain paired old/new coordinates', () => {
  const [file] = parseGitDiff(header + `@@ -1,2 +1,2 @@
-function a() { return 1; }
-function b() { return 2; }
+function a() { return 10; }
+function b() { return 20; }`);
  for (const [name, line] of [['a', 1], ['b', 2]] as const) {
    const range = { name, startLine: line, endLine: line };
    const change = extractEntityChange(file, range, range)!;
    assert.match(change.diff, new RegExp(`@@ -${line},1 \\+${line},1 @@`));
    assert.doesNotMatch(change.diff, new RegExp(`function ${name === 'a' ? 'b' : 'a'}`));
  }
});
