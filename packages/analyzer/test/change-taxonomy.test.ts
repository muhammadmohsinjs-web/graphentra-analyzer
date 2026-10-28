import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { classifyChange, fingerprintsOf, type EntityFingerprints } from '../src/change-taxonomy';
import type { ChangeClass, ChangeKind } from '../src/contracts';

function fp(code: string, name = 'f'): EntityFingerprints {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `entity ${name} not found in: ${code}`);
  return fingerprintsOf(found);
}

interface Case {
  name: string;
  base: string;
  head: string;
  expect: ChangeClass[];
  kind?: ChangeKind;
  file?: string;
  baseName?: string;
  headName?: string;
}

const cases: Case[] = [
  // cosmetic
  { name: 'cosmetic: whitespace reformat', base: 'function f(a: number) { return a + 1; }', head: 'function f(a: number) {\n  return a   +   1;\n}', expect: ['cosmetic'] },
  { name: 'cosmetic: comments added', base: 'function f(a: number) { return a + 1; }', head: '// hi\nfunction f(a: number) {\n /* c */ return a + 1; // end\n}', expect: ['cosmetic'] },
  { name: 'cosmetic: trailing commas', base: 'function f(a: number, b: number) { return g(a, b); }', head: 'function f(a: number, b: number,) { return g(a, b,); }', expect: ['cosmetic'] },
  // body
  { name: 'body: string literal change', base: 'function f() { return "a"; }', head: 'function f() { return "b"; }', expect: ['body'] },
  { name: 'body: object key reorder', base: 'function f() { return { a: 1, b: 2 }; }', head: 'function f() { return { b: 2, a: 1 }; }', expect: ['body'] },
  { name: 'body: statement change', base: 'function f(a: number) { return a + 1; }', head: 'function f(a: number) { return a - 1; }', expect: ['body'] },
  { name: 'body: exported body change stays body', base: 'export function f(a: number) { return a; }', head: 'export function f(a: number) { return a + 1; }', expect: ['body'] },
  // signature
  { name: 'signature: async added', base: 'function f() { return 1; }', head: 'async function f() { return 1; }', expect: ['signature'] },
  { name: 'signature: param type', base: 'function f(a: number) { return a; }', head: 'function f(a: string) { return a; }', expect: ['signature'] },
  { name: 'signature: return type', base: 'function f(): number { return 1; }', head: 'function f(): string { return "1"; }', expect: ['signature'] },
  { name: 'signature: generic added', base: 'function f(a: number) { return a; }', head: 'function f<T>(a: number) { return a; }', expect: ['signature'] },
  { name: 'signature: param added', base: 'function f(a: number) { return a; }', head: 'function f(a: number, b: number) { return a; }', expect: ['signature'] },
  // param names are part of signatureOf, so a rename is a signature change (never cosmetic)
  { name: 'signature: param rename', base: 'function f(a: number) { return a; }', head: 'function f(b: number) { return b; }', expect: ['signature'] },
  // export_surface (signatureOf includes export modifiers, so signature co-occurs when the keyword changes)
  { name: 'export_surface: export added', base: 'function f() { return 1; }', head: 'export function f() { return 1; }', expect: ['export_surface', 'signature'] },
  { name: 'export_surface: export removed', base: 'export function f() { return 1; }', head: 'function f() { return 1; }', expect: ['export_surface', 'signature'] },
  { name: 'export_surface: default to named', base: 'export default function f() { return 1; }', head: 'export function f() { return 1; }', expect: ['export_surface', 'signature'] },
  { name: 'export_surface: export specifier added', base: 'function f() { return 1; }', head: 'function f() { return 1; }\nexport { f };', expect: ['export_surface'] },
  { name: 'export_surface: renamed export', base: 'export function f() { return 1; }', head: 'export function g() { return 1; }', baseName: 'f', headName: 'g', kind: 'renamed', expect: ['body', 'export_surface', 'renamed'] }, // name is part of the full fingerprint, so body too
  // log_only
  { name: 'log_only: console.log added', base: 'function f() { return 1; }', head: 'function f() { console.log("x"); return 1; }', expect: ['log_only'] },
  { name: 'log_only: console.log removed', base: 'function f() { console.log("x"); return 1; }', head: 'function f() { return 1; }', expect: ['log_only'] },
  { name: 'log_only: logger.info changed', base: 'function f() { logger.info("a"); return 1; }', head: 'function f() { logger.info("b"); return 1; }', expect: ['log_only'] },
  { name: 'body: log plus real change', base: 'function f() { console.log("x"); return 1; }', head: 'function f() { return 2; }', expect: ['body'] },
  // test_only
  { name: 'test_only: cosmetic in __tests__', base: 'function f() { return 1; }', head: 'function  f() { return 1; }', file: 'src/__tests__/a.ts', expect: ['cosmetic', 'test_only'] },
  { name: 'test_only: body in .test.ts', base: 'function f() { return 1; }', head: 'function f() { return 2; }', file: 'a.test.ts', expect: ['body', 'test_only'] },
  { name: 'test_only: signature in test/', base: 'function f() { return 1; }', head: 'async function f() { return 1; }', file: 'test/x.ts', expect: ['signature', 'test_only'] },
];

for (const c of cases) {
  test(`classify ${c.name}`, () => {
    const result = classifyChange({
      changeKind: c.kind ?? 'modified',
      file: c.file ?? 'src/a.ts',
      base: fp(c.base, c.baseName),
      head: fp(c.head, c.headName),
    });
    assert.deepEqual(result, c.expect);
  });
}

const ok = fp('function f() { return 1; }');

test('added / deleted do not compare fingerprints', () => {
  assert.deepEqual(classifyChange({ changeKind: 'added', file: 'a.ts', head: ok }), ['added']);
  assert.deepEqual(classifyChange({ changeKind: 'deleted', file: 'a.ts', base: ok }), ['deleted']);
  assert.deepEqual(classifyChange({ changeKind: 'added', file: 'a.test.ts' }), ['added', 'test_only']);
});

test('renamed with identical fingerprints is renamed only (not cosmetic)', () => {
  assert.deepEqual(classifyChange({ changeKind: 'renamed', file: 'a.ts', base: ok, head: ok }), ['renamed']);
});

test('renamed with body change adds body', () => {
  const head = fp('function f() { return 2; }');
  assert.deepEqual(classifyChange({ changeKind: 'renamed', file: 'b.ts', base: ok, head }), ['body', 'renamed']);
});

test('missing fingerprints on modified escalate to body', () => {
  assert.deepEqual(classifyChange({ changeKind: 'modified', file: 'a.ts' }), ['body']);
  assert.deepEqual(classifyChange({ changeKind: 'modified', file: 'a.ts', base: ok }), ['body']);
  assert.deepEqual(classifyChange({ changeKind: 'modified', file: 'a.ts', head: ok }), ['body']);
});

test('output is sorted, unique and never empty', () => {
  const r = classifyChange({ changeKind: 'renamed', file: 'a.test.ts', base: fp('function f() {}'), head: fp('export function g() {}', 'g') });
  assert.deepEqual(r, [...new Set(r)].sort());
  assert.ok(r.includes('test_only') && r.includes('renamed'));
  for (const kind of ['added', 'deleted', 'modified', 'renamed'] as ChangeKind[]) {
    assert.ok(classifyChange({ changeKind: kind, file: 'a.ts' }).length > 0);
  }
});
