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

test('extended engine matches legacy', () => {
  const sf = parse();
  const strip = (engine: 'legacy' | 'extended') =>
    collectEntities(sf, { relativeFile: 'a.ts', engine }).map(c => c.entity);
  assert.deepEqual(strip('extended'), strip('legacy'));
});
