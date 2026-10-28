import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityKind } from '../src/contracts';
import { baseToHeadId, correspond, type Correspondence, type FingerprintedEntity } from '../src/correspondence';

const ent = (id: string, fp: string, kind: EntityKind = 'function'): FingerprintedEntity => {
  const [file, name] = id.split('#');
  return { id, kind, name, file, startLine: 1, endLine: 5, fp };
};
const ids = (list: Array<{ id: string }>) => list.map((entity) => entity.id);
const pairs = (list: Array<{ base: { id: string }; head: { id: string } }>) => list.map((p) => [p.base.id, p.head.id]);
const summary = (c: Correspondence) => ({
  matched: pairs(c.matched), renamed: pairs(c.renamed), moved: pairs(c.moved),
  added: ids(c.added), deleted: ids(c.deleted),
  ambiguous: c.ambiguous.map((a) => ({ fp: a.fp, base: ids(a.base), head: ids(a.head) })),
});
const empty = { matched: [], renamed: [], moved: [], added: [], deleted: [], ambiguous: [] };

interface Row {
  name: string;
  base: FingerprintedEntity[];
  head: FingerprintedEntity[];
  expect: Partial<ReturnType<typeof summary>>;
}

const rows: Row[] = [
  {
    name: 'same id is matched even when the body changed',
    base: [ent('a.ts#f', 'x'), ent('a.ts#g', 'y')],
    head: [ent('a.ts#f', 'x2'), ent('a.ts#g', 'y')],
    expect: { matched: [['a.ts#f', 'a.ts#f'], ['a.ts#g', 'a.ts#g']] },
  },
  {
    name: 'unique fingerprint in the same file is a rename',
    base: [ent('a.ts#old', 'body')],
    head: [ent('a.ts#fresh', 'body')],
    expect: { renamed: [['a.ts#old', 'a.ts#fresh']] },
  },
  {
    name: 'unique fingerprint in another file is a move',
    base: [ent('a.ts#f', 'body')],
    head: [ent('b.ts#f', 'body')],
    expect: { moved: [['a.ts#f', 'b.ts#f']] },
  },
  {
    name: 'rename plus move is a move',
    base: [ent('a.ts#f', 'body')],
    head: [ent('b.ts#g', 'body')],
    expect: { moved: [['a.ts#f', 'b.ts#g']] },
  },
  {
    name: 'rename with a body edit (different fingerprint) is deleted + added',
    base: [ent('a.ts#old', 'body')],
    head: [ent('a.ts#fresh', 'body edited')],
    expect: { deleted: ['a.ts#old'], added: ['a.ts#fresh'] },
  },
  {
    name: 'identical helpers in two files, both renamed, are ambiguous and also deleted + added',
    base: [ent('a.ts#helper', 'same'), ent('b.ts#helper', 'same')],
    head: [ent('a.ts#util', 'same'), ent('b.ts#util', 'same')],
    expect: {
      ambiguous: [{ fp: 'same', base: ['a.ts#helper', 'b.ts#helper'], head: ['a.ts#util', 'b.ts#util'] }],
      deleted: ['a.ts#helper', 'b.ts#helper'],
      added: ['a.ts#util', 'b.ts#util'],
    },
  },
  {
    name: 'one base and two heads sharing a fingerprint is ambiguous (copy, not rename)',
    base: [ent('a.ts#f', 'body')],
    head: [ent('a.ts#g', 'body'), ent('b.ts#g', 'body')],
    expect: {
      ambiguous: [{ fp: 'body', base: ['a.ts#f'], head: ['a.ts#g', 'b.ts#g'] }],
      deleted: ['a.ts#f'],
      added: ['a.ts#g', 'b.ts#g'],
    },
  },
  {
    name: 'two empty functions renamed simultaneously are ambiguous',
    base: [ent('a.ts#noopA', ''), ent('a.ts#noopB', '')],
    head: [ent('a.ts#idleA', ''), ent('a.ts#idleB', '')],
    expect: {
      ambiguous: [{ fp: '', base: ['a.ts#noopA', 'a.ts#noopB'], head: ['a.ts#idleA', 'a.ts#idleB'] }],
      deleted: ['a.ts#noopA', 'a.ts#noopB'],
      added: ['a.ts#idleA', 'a.ts#idleB'],
    },
  },
  {
    name: 'same fingerprint with different kinds never matches',
    base: [ent('a.ts#f', 'body', 'function')],
    head: [ent('a.ts#C.f', 'body', 'method')],
    expect: { deleted: ['a.ts#f'], added: ['a.ts#C.f'] },
  },
  {
    name: 'kind is part of the group: a function and a method with one fingerprint do not collide',
    base: [ent('a.ts#f', 'body', 'function'), ent('a.ts#C.m', 'body', 'method')],
    head: [ent('a.ts#g', 'body', 'function'), ent('a.ts#C.n', 'body', 'method')],
    expect: { renamed: [['a.ts#C.m', 'a.ts#C.n'], ['a.ts#f', 'a.ts#g']] },
  },
  {
    name: 'module entities never rename-match, but still match by id',
    base: [ent('a.ts#<module>', 'm', 'module'), ent('b.ts#<module>', 'm2', 'module')],
    head: [ent('c.ts#<module>', 'm', 'module'), ent('b.ts#<module>', 'm2', 'module')],
    expect: {
      matched: [['b.ts#<module>', 'b.ts#<module>']],
      deleted: ['a.ts#<module>'],
      added: ['c.ts#<module>'],
    },
  },
  {
    name: 'nested child of a renamed parent pairs through its own fingerprint',
    base: [ent('a.ts#outer', 'outer body'), ent('a.ts#outer>inner', 'inner body', 'function')],
    head: [ent('a.ts#renamed', 'outer body'), ent('a.ts#renamed>inner', 'inner body', 'function')],
    expect: { renamed: [['a.ts#outer', 'a.ts#renamed'], ['a.ts#outer>inner', 'a.ts#renamed>inner']] },
  },
  {
    name: 'nested child of a moved parent pairs through its own fingerprint',
    base: [ent('a.ts#C.m', 'm body', 'method'), ent('a.ts#C.m>helper', 'helper body')],
    head: [ent('b.ts#C.m', 'm body', 'method'), ent('b.ts#C.m>helper', 'helper body')],
    expect: { moved: [['a.ts#C.m', 'b.ts#C.m'], ['a.ts#C.m>helper', 'b.ts#C.m>helper']] },
  },
  {
    name: 'base-only and head-only entities are deleted and added',
    base: [ent('a.ts#gone', 'one')],
    head: [ent('a.ts#born', 'two')],
    expect: { deleted: ['a.ts#gone'], added: ['a.ts#born'] },
  },
  {
    name: 'an id that exists on both sides never feeds a rename group',
    base: [ent('a.ts#f', 'body'), ent('a.ts#h', 'body')],
    head: [ent('a.ts#f', 'other'), ent('a.ts#k', 'body')],
    expect: { matched: [['a.ts#f', 'a.ts#f']], renamed: [['a.ts#h', 'a.ts#k']] },
  },
  { name: 'empty inputs', base: [], head: [], expect: {} },
];

for (const row of rows) {
  test(`correspondence: ${row.name}`, () => {
    assert.deepEqual(summary(correspond(row.base, row.head)), { ...empty, ...row.expect });
  });
}

test('correspondence: entities are passed through unchanged (same objects, fp intact)', () => {
  const base = [ent('a.ts#old', 'body'), ent('a.ts#gone', 'x')];
  const head = [ent('a.ts#fresh', 'body')];
  const c = correspond(base, head);
  assert.equal(c.renamed[0].base, base[0]);
  assert.equal(c.renamed[0].head, head[0]);
  assert.equal(c.deleted[0], base[1]);
});

test('correspondence: output is identical for shuffled input order', () => {
  const base = [
    ent('a.ts#same', 's'), ent('a.ts#h1', 'dup'), ent('b.ts#h1', 'dup'), ent('a.ts#old', 'r'),
    ent('c.ts#mv', 'm'), ent('a.ts#C.m', 'cm', 'method'), ent('a.ts#<module>', 'x', 'module'), ent('a.ts#gone', 'g'),
  ];
  const head = [
    ent('a.ts#same', 's'), ent('a.ts#u1', 'dup'), ent('b.ts#u1', 'dup'), ent('a.ts#fresh', 'r'),
    ent('d.ts#mv', 'm'), ent('a.ts#C.n', 'cm', 'method'), ent('z.ts#<module>', 'x', 'module'), ent('a.ts#born', 'b'),
  ];
  const expected = summary(correspond(base, head));
  const rotate = <T>(list: T[], by: number) => [...list.slice(by), ...list.slice(0, by)];
  for (let by = 1; by < base.length; by++) {
    assert.deepEqual(summary(correspond(rotate(base, by), [...rotate(head, by + 2)].reverse())), expected);
    assert.deepEqual(summary(correspond([...base].reverse(), rotate(head, by))), expected);
  }
  assert.deepEqual(expected.renamed, [['a.ts#C.m', 'a.ts#C.n'], ['a.ts#old', 'a.ts#fresh']]);
  assert.deepEqual(expected.moved, [['c.ts#mv', 'd.ts#mv']]);
});

test('baseToHeadId: matched + renamed + moved only', () => {
  const c = correspond(
    [ent('a.ts#same', 's'), ent('a.ts#old', 'r'), ent('a.ts#mv', 'm'), ent('a.ts#gone', 'g'), ent('a.ts#d1', 'dup'), ent('b.ts#d1', 'dup')],
    [ent('a.ts#same', 's'), ent('a.ts#fresh', 'r'), ent('b.ts#mv', 'm'), ent('a.ts#born', 'b'), ent('a.ts#d2', 'dup'), ent('b.ts#d2', 'dup')],
  );
  assert.deepEqual([...baseToHeadId(c)], [
    ['a.ts#mv', 'b.ts#mv'], ['a.ts#old', 'a.ts#fresh'], ['a.ts#same', 'a.ts#same'],
  ]);
});
