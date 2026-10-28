import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { exportSurfaceOf, fingerprint, normalizeNode, signatureOf } from '../src/ast-normalize';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('sample.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// Entity under test: first top-level statement (function, variable statement, class).
const entity = (code: string): ts.Node => parse(code).statements[0];
const norm = (code: string, options?: Parameters<typeof normalizeNode>[1]): string =>
  normalizeNode(entity(code), options);

const equalCases: Array<[string, string, string]> = [
  ['whitespace', 'function f(a) { return a + 1; }', 'function   f(a)\n{\n\n    return a+1 ;\n}'],
  ['comments', 'function f(a) { return a; }', 'function f(a) { /* c */ return a; // t\n}'],
  ['redundant parens', 'const x = a + b;', 'const x = (a + b);'],
  ['nested redundant parens', 'const x = a * b;', 'const x = ((a) * (b));'],
  ['semantic parens kept equal', 'const x = (a + b) * c;', 'const x = ((a + b)) * c;'],
  ['trailing comma args', 'f(a, b);', 'f(a, b,);'],
  ['trailing comma array', 'const x = [1, 2];', 'const x = [1, 2,];'],
  ['trailing comma object', 'const x = { a: 1, b: 2 };', 'const x = { a: 1, b: 2, };'],
  ['trailing comma params', 'function f(a, b) {}', 'function f(a, b,) {}'],
];

for (const [name, left, right] of equalCases) {
  test(`equal: ${name}`, () => assert.equal(norm(left), norm(right)));
}

const unequalCases: Array<[string, string, string]> = [
  ['parens that change precedence', 'const x = (a + b) * c;', 'const x = a + b * c;'],
  ['string literal', 'const x = "a";', 'const x = "b";'],
  ['number literal', 'const x = 1;', 'const x = 2;'],
  ['object key order', 'const x = { a: 1, b: 2 };', 'const x = { b: 2, a: 1 };'],
  ['statement order', 'function f() { a(); b(); }', 'function f() { b(); a(); }'],
  ['operator', 'const x = a + b;', 'const x = a - b;'],
  ['prefix operator', 'const x = !a;', 'const x = -a;'],
  ['let vs const', 'let x = 1;', 'const x = 1;'],
  ['identifier', 'const x = a;', 'const x = b;'],
  ['template text', 'const x = `a${b}`;', 'const x = `c${b}`;'],
];

for (const [name, left, right] of unequalCases) {
  test(`not equal: ${name}`, () => assert.notEqual(norm(left), norm(right)));
}

test('signatureOf: async changes signature, body edits do not', () => {
  const base = signatureOf(entity('function f(a: number): number { return a; }'));
  assert.notEqual(base, signatureOf(entity('async function f(a: number): number { return a; }')));
  assert.equal(base, signatureOf(entity('function f(a: number): number { return a + 1; }')));
});

test('signatureOf: param type, return type, generics, param name', () => {
  const base = signatureOf(entity('function f(a: number): number { return a; }'));
  assert.notEqual(base, signatureOf(entity('function f(a: string): number { return a; }')));
  assert.notEqual(base, signatureOf(entity('function f(a: number): string { return a; }')));
  assert.notEqual(base, signatureOf(entity('function f<T>(a: number): number { return a; }')));
  assert.notEqual(base, signatureOf(entity('function f(b: number): number { return b; }')));
  assert.notEqual(base, signatureOf(entity('function f(a?: number): number { return a; }')));
  assert.notEqual(base, signatureOf(entity('function f(...a: number[]): number { return a; }')));
  assert.notEqual(base, signatureOf(entity('function* f(a: number): number { return a; }')));
  assert.notEqual(
    signatureOf(entity('function f<T>(a: T) {}')),
    signatureOf(entity('function f<T extends object>(a: T) {}')),
  );
  assert.notEqual(signatureOf(entity('function f(a = 1) {}')), signatureOf(entity('function f(a = 2) {}')));
});

test('signatureOf: variable-assigned arrows pick up export modifiers', () => {
  const plain = signatureOf(entity('const f = (a: number) => a;'));
  const exported = signatureOf(entity('export const f = (a: number) => a;'));
  assert.notEqual(plain, exported);
  const arrow = (entity('export const f = (a: number) => a;') as ts.VariableStatement).declarationList.declarations[0]
    .initializer!;
  assert.equal(signatureOf(arrow), exported);
});

test('signatureOf: member modifiers', () => {
  const cls = entity('class C { m() {} static async s() {} private p() {} }') as ts.ClassDeclaration;
  const [m, s, p] = cls.members;
  assert.equal(new Set([signatureOf(m), signatureOf(s), signatureOf(p)]).size, 3);
});

test('exportSurfaceOf', () => {
  assert.equal(exportSurfaceOf(entity('function f() {}')), 'none');
  assert.equal(exportSurfaceOf(entity('export function f() {}')), 'named:f');
  assert.equal(exportSurfaceOf(entity('export default function f() {}')), 'default');
  assert.equal(exportSurfaceOf(entity('export const f = () => 1;')), 'named:f');
  assert.equal(exportSurfaceOf(entity('function f() {}\nexport { f as g };')), 'named:g');
  assert.equal(exportSurfaceOf(entity('function f() {}\nexport default f;')), 'default');
});

test('renameParams: param rename plus uses is equal', () => {
  const left = 'function f(a, b) { return a + b; }';
  const right = 'function f(x, y) { return x + y; }';
  assert.notEqual(norm(left), norm(right));
  assert.equal(norm(left, { renameParams: true }), norm(right, { renameParams: true }));
});

test('renameParams: function name ignored, arrow in variable too', () => {
  assert.equal(
    norm('function f(a) { return a; }', { renameParams: true }),
    norm('function g(a) { return a; }', { renameParams: true }),
  );
  assert.equal(
    norm('const f = (a) => a * 2;', { renameParams: true }),
    norm('const g = (b) => b * 2;', { renameParams: true }),
  );
});

test('renameParams: different body, swapped params, property names and shadowing', () => {
  const opts = { renameParams: true };
  assert.notEqual(norm('function f(a) { return a + 1; }', opts), norm('function f(a) { return a + 2; }', opts));
  assert.notEqual(norm('function f(a, b) { return a - b; }', opts), norm('function f(a, b) { return b - a; }', opts));
  assert.notEqual(norm('function f(a) { return o.a; }', opts), norm('function f(a) { return o.b; }', opts));
  assert.notEqual(norm('function f(a) { return { a }; }', opts), norm('function f(b) { return { b }; }', opts));
  assert.equal(
    norm('function f(a) { return (a) => a; }', opts),
    norm('function f(z) { return (a) => a; }', opts),
  );
  assert.notEqual(norm('function f(a) { return a; }', opts), norm('function f(a, b) { return a; }', opts));
});

test('dropLogCalls: only equal when enabled', () => {
  const withLog = 'function f(x) { console.log(x); return x; }';
  const without = 'function f(x) { return x; }';
  assert.notEqual(norm(withLog), norm(without));
  assert.equal(norm(withLog, { dropLogCalls: true }), norm(without, { dropLogCalls: true }));
  for (const call of ['logger.info(x);', 'this.logger.debug(x);', 'log.warn(x);', 'console.error(x);']) {
    assert.equal(
      norm(`class C { m(x) { ${call} return x; } }`, { dropLogCalls: true }),
      norm('class C { m(x) { return x; } }', { dropLogCalls: true }),
      call,
    );
  }
});

test('dropLogCalls: non-log call changes still differ', () => {
  const opts = { dropLogCalls: true };
  assert.notEqual(
    norm('function f(x) { console.log(x); save(x); }', opts),
    norm('function f(x) { console.log(x); store(x); }', opts),
  );
  assert.notEqual(norm('function f(x) { save(x); }', opts), norm('function f(x) { }', opts));
});

test('determinism and fingerprint', () => {
  const code = 'export async function f<T>(a: T, ...r: number[]) { return { a, r, s: `x${a}` }; }';
  assert.equal(norm(code), norm(code));
  assert.equal(signatureOf(entity(code)), signatureOf(entity(code)));
  assert.equal(norm(code, { renameParams: true, dropLogCalls: true }), norm(code, { renameParams: true, dropLogCalls: true }));
  assert.match(fingerprint(norm(code)), /^[0-9a-f]{64}$/);
  assert.equal(fingerprint('a'), fingerprint('a'));
  assert.notEqual(fingerprint('a'), fingerprint('b'));
});
