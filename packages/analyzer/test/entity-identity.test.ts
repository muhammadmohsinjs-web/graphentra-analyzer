import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_EXPORT_SEGMENT, MODULE_SEGMENT, accessorSegment, buildEntityId, createIdAllocator, escapeSegment,
  memberName, nestedName, overloadSegment, parseEntityId, unescapeSegment,
} from '../src/entity-identity';

test('TypeScript construct IDs', () => {
  const id = buildEntityId;
  assert.equal(id('src/a.ts', 'f'), 'src/a.ts#f');
  assert.equal(id('src/a.ts', memberName('C', 'm')), 'src/a.ts#C.m');
  assert.equal(id('src/a.ts', memberName('C', 'constructor')), 'src/a.ts#C.constructor');
  assert.equal(id('src/a.ts', memberName('C', accessorSegment('get', 'x'))), 'src/a.ts#C.get x');
  assert.equal(id('src/a.ts', memberName('C', accessorSegment('set', 'x'))), 'src/a.ts#C.set x');
  assert.equal(id('src/a.ts', memberName('obj', 'm')), 'src/a.ts#obj.m');
  assert.equal(id('src/a.ts', DEFAULT_EXPORT_SEGMENT), 'src/a.ts#default');
  assert.equal(id('src/Button.tsx', 'Button'), 'src/Button.tsx#Button');
  assert.equal(id('src/a.ts', MODULE_SEGMENT), 'src/a.ts#<module>');
  assert.equal(id('src/a.ts', nestedName('outer', 'inner')), 'src/a.ts#outer>inner');
  assert.equal(id('src/a.ts', nestedName(memberName('C', 'm'), 'helper')), 'src/a.ts#C.m>helper');
  assert.equal(id('src/a.ts', memberName('C', escapeSegment('a.b'))), 'src/a.ts#C.a%2Eb');
});

test('other language IDs (grammar only)', () => {
  const id = buildEntityId;
  assert.equal(id('app/models.py', memberName('Cart', 'add')), 'app/models.py#Cart.add');
  assert.equal(id('app/models.py', MODULE_SEGMENT), 'app/models.py#<module>');
  assert.equal(id('app/models/user.rb', memberName('User', escapeSegment('valid?'))), 'app/models/user.rb#User.valid?');
  assert.equal(id('src/List.cs', memberName(escapeSegment('List<T>'), 'Add')), 'src/List.cs#List%3CT%3E.Add');
  assert.equal(id('src/Cart.java', memberName('Cart', overloadSegment('add', ['int']))), 'src/Cart.java#Cart.add(int)');
  assert.equal(id('src/Cart.java', memberName('Cart', overloadSegment('add', ['String']))), 'src/Cart.java#Cart.add(String)');
  assert.notEqual(overloadSegment('add', ['int']), overloadSegment('add', ['String']));
  assert.equal(memberName('Map', overloadSegment('put', ['K', 'V'])), 'Map.put(K,V)');
  assert.equal(id('pkg/server.go', memberName('Server', 'Start')), 'pkg/server.go#Server.Start');
});

test('escape/unescape round trip', () => {
  for (const s of ['', '#', '%', '%2E', 'a.b>c<d', 'x y', '~', 'café', '(a,b)']) {
    assert.equal(unescapeSegment(escapeSegment(s)), s);
  }
  assert.equal(escapeSegment('100%'), '100%25');
  assert.equal(escapeSegment('a$b!c?'), 'a$b!c?');
});

test('parseEntityId splits at the last #', () => {
  assert.deepEqual(parseEntityId('src/we#ird/a.ts#C.m'), { file: 'src/we#ird/a.ts', qualifiedName: 'C.m' });
  assert.throws(() => parseEntityId('no-hash'));
});

test('duplicate allocator is deterministic', () => {
  const allocator = createIdAllocator();
  assert.deepEqual(['f', 'f', 'g', 'f'].map(x => allocator.allocate(x)), [
    { id: 'f', disambiguated: false }, { id: 'f~2', disambiguated: true },
    { id: 'g', disambiguated: false }, { id: 'f~3', disambiguated: true },
  ]);
});

test('reserved segments are not escaped and cannot be forged', () => {
  assert.equal(MODULE_SEGMENT, '<module>');
  assert.equal(DEFAULT_EXPORT_SEGMENT, 'default');
  assert.notEqual(escapeSegment('<module>'), MODULE_SEGMENT);
  assert.equal(escapeSegment('<module>'), '%3Cmodule%3E');
});
