import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { collectEntities } from '../src/entity-collector';

const source = [
  'export function outer() {',
  '  function inner() {}',
  '}',
  'const f = () => {};',
  'function last() {}',
].join('\n');

function parse(): ts.SourceFile {
  return ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true);
}

test('collects named function declarations in pre-order', () => {
  const candidates = collectEntities(parse(), { relativeFile: 'a.ts', engine: 'legacy' });
  assert.deepEqual(candidates.map(c => c.entity), [
    { id: 'a.ts#outer', kind: 'function', name: 'outer', file: 'a.ts', startLine: 1, endLine: 3 },
    { id: 'a.ts#inner', kind: 'function', name: 'inner', file: 'a.ts', startLine: 2, endLine: 2 },
    { id: 'a.ts#last', kind: 'function', name: 'last', file: 'a.ts', startLine: 5, endLine: 5 },
  ]);
});

test('does not return arrow functions', () => {
  const candidates = collectEntities(parse(), { relativeFile: 'a.ts', engine: 'legacy' });
  assert.equal(candidates.some(c => c.entity.name === 'f'), false);
});

test('symbolNodes[0] is the name identifier', () => {
  const [first] = collectEntities(parse(), { relativeFile: 'a.ts', engine: 'legacy' });
  assert.ok(ts.isFunctionDeclaration(first.declarationNode));
  assert.equal(first.symbolNodes[0], first.declarationNode.name);
});

test('extended engine adds nesting, variable-bound functions and exported flags', () => {
  const candidates = collectEntities(parse(), { relativeFile: 'a.ts', engine: 'extended' });
  assert.deepEqual(candidates.map(c => c.entity.id), ['a.ts#<module>', 'a.ts#outer', 'a.ts#outer>inner', 'a.ts#f', 'a.ts#last']);
  assert.equal(candidates[0]!.entity.kind, 'module');
  assert.equal(candidates[1]!.parent, candidates[0]);
  assert.equal(candidates[2]!.parent, candidates[1]);
  assert.equal(candidates[1]!.entity.exported, true);
  assert.equal(candidates[3]!.entity.exported, false);
});

const extendedIds = (code: string): string[] =>
  collectEntities(ts.createSourceFile('a.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), { relativeFile: 'a.tsx', engine: 'extended' })
    .map(candidate => candidate.entity.id);

test('extended: a function wrapped in a plain call is an entity', () => {
  assert.ok(extendedIds('const run = throttle(() => {});').includes('a.tsx#run'));
});

test('extended: a class property holding a wrapped function is an entity', () => {
  assert.ok(extendedIds('class App { paste = withBatch(async () => {}); }').includes('a.tsx#App.paste'));
});

test('extended: members of an object literal handed to a plain call are entities', () => {
  const ids = extendedIds('export const action = register({ name: "x", perform: () => {}, Panel() { return null; } });');
  assert.ok(ids.includes('a.tsx#action.perform'));
  assert.ok(ids.includes('a.tsx#action.Panel'));
});

test('extended: a method call result and a call with other arguments are not entities', () => {
  const ids = extendedIds('const items = list.map(x => x);\nconst table = build({ a: 1 }, 2);');
  assert.ok(!ids.includes('a.tsx#items'));
  assert.ok(!ids.includes('a.tsx#table'));
});
