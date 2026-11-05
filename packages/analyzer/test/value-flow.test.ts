import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { createRepo } from './helpers/git-fixture';

const SHOP: Record<string, string> = {
  'src/catalog.ts': "const PRICES = { tea: 500 };\nexport const getPrice = (code: string) => PRICES[code as 'tea'] ?? 0;\n",
  'src/customers.ts': "export const getName = (id: string) => `Ada ${id}`;\n",
  'src/payment.ts': 'export const charge = (cents: number) => `$${cents / 100}`;\n',
  'src/receipt.ts': "const firstName = (full: string) => full.split(' ')[0];\nexport const receipt = (full: string, code: string) => `Thanks ${firstName(full)} for ${code}`;\n",
  'src/stock.ts': 'export const stockOf = (code: string) => code.length;\n',
  'src/shop.ts': [
    "import { getPrice } from './catalog';",
    "import { getName } from './customers';",
    "import { charge } from './payment';",
    "import { receipt } from './receipt';",
    "import { stockOf } from './stock';",
    'export const placeOrder = (id: string, code: string, qty: number) => {',
    '  if (stockOf(code) < qty) return null;',
    '  const charged = charge(getPrice(code) * qty);',
    '  const note = receipt(getName(id), code);',
    '  return { charged, note };',
    '};',
    '',
  ].join('\n'),
};

function received(edits: Record<string, (source: string) => string>, base: Record<string, string> = SHOP) {
  const repo = createRepo();
  try {
    for (const [file, source] of Object.entries(base)) repo.commitFile(file, source);
    for (const [file, edit] of Object.entries(edits)) {
      const full = path.join(repo.dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, edit(fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : ''));
    }
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'extended' });
    const targets = result.impacts.flatMap(impact => impact.receivesChangedValue ?? []);
    return { ids: new Set(targets.map(target => target.entity.id)), targets, result };
  } finally { repo.cleanup(); }
}

test('value flow: a changed return reaches only the function its caller passes it to', () => {
  const { ids } = received({ 'src/catalog.ts': source => source.replace('?? 0;', '?? 0) / 100;').replace('=> PRICES', '=> (PRICES') });
  assert.ok(ids.has('src/payment.ts#charge'));
  for (const clean of ['src/stock.ts#stockOf', 'src/receipt.ts#receipt', 'src/customers.ts#getName']) assert.ok(!ids.has(clean), clean);
});

test('value flow: a changed argument reaches its callee and the callee it hands the value to', () => {
  const { ids, targets } = received({ 'src/shop.ts': source => source.replace('receipt(getName(id), code)', 'receipt(`Ms. ${getName(id)}`, code)') });
  assert.ok(ids.has('src/receipt.ts#receipt'));
  assert.ok(ids.has('src/receipt.ts#firstName'));
  assert.equal(targets.find(target => target.entity.id === 'src/receipt.ts#firstName')?.through, 'src/receipt.ts#receipt');
  for (const clean of ['src/stock.ts#stockOf', 'src/catalog.ts#getPrice', 'src/payment.ts#charge', 'src/customers.ts#getName']) assert.ok(!ids.has(clean), clean);
});

test('value flow: a changed constant reaches its readers and what they feed', () => {
  const { ids, result } = received({ 'src/catalog.ts': source => source.replace('tea: 500', 'tea: 5') });
  assert.deepEqual(result.impacts.map(impact => impact.changedEntity.id), ['src/catalog.ts#<module>']);
  for (const hit of ['src/catalog.ts#getPrice', 'src/shop.ts#placeOrder', 'src/payment.ts#charge']) assert.ok(ids.has(hit), hit);
  assert.ok(!ids.has('src/stock.ts#stockOf'));
});

test('value flow: a helper handing the value back taints only the call that passed it', () => {
  const base = {
    'src/helper.ts': 'export const trim = (text: string) => text.trim();\n',
    'src/sink.ts': 'export const sink = (text: string) => text.length;\nexport const other = (text: string) => text.length;\n',
    'src/app.ts': [
      "import { trim } from './helper';",
      "import { sink, other } from './sink';",
      "export const changed = (text: string) => sink(trim(text));",
      "export const unrelated = (text: string) => other(trim(text));",
      '',
    ].join('\n'),
  };
  const { ids } = received({ 'src/app.ts': source => source.replace('sink(trim(text))', 'sink(trim(text + "!"))') }, base);
  assert.ok(ids.has('src/sink.ts#sink'));
  assert.ok(!ids.has('src/sink.ts#other'));
  assert.ok(!ids.has('src/app.ts#unrelated'));
});

test('value flow: comparing a value does not pass it on, and test files are not listed', () => {
  const base = {
    'src/lib.ts': 'export const size = () => 1;\nexport const sink = (value: unknown) => value;\n',
    'src/app.ts': "import { size, sink } from './lib';\nexport const use = () => { if (size() > 0) return sink(0); return sink(size()); };\n",
    'test/app.test.ts': "import { size, sink } from '../src/lib';\nexport const check = () => sink(size());\n",
    'src/compare.ts': "import { size, sink } from './lib';\nexport const compare = () => (size() === 1 ? sink('a') : sink('b'));\n",
  };
  const { ids } = received({ 'src/lib.ts': source => source.replace('() => 1', '() => 2') }, base);
  assert.ok(ids.has('src/lib.ts#sink'));
  assert.ok(![...ids].some(id => id.startsWith('test/')));
});

test('value flow: a new function is not a source, and the field is absent when nothing receives a value', () => {
  const { targets, result } = received({ 'src/added.ts': () => "import { charge } from './payment';\nexport const added = () => charge(1);\n" });
  assert.deepEqual(targets, []);
  assert.ok(result.impacts.every(impact => !('receivesChangedValue' in impact)));
});

test('value flow: targets are sorted and flagged entities are not repeated', () => {
  const { targets, result } = received({ 'src/catalog.ts': source => source.replace('tea: 500', 'tea: 5') });
  const ids = targets.map(target => target.entity.id);
  assert.deepEqual(ids, [...ids].sort());
  const blast = new Set(result.impacts.flatMap(impact => impact.blastRadius.entities.map(entity => entity.id)));
  assert.ok(ids.every(id => !blast.has(id)));
});

test('value flow: the legacy engine reports nothing', () => {
  const repo = createRepo();
  try {
    for (const [file, source] of Object.entries(SHOP)) repo.commitFile(file, source);
    fs.writeFileSync(path.join(repo.dir, 'src/shop.ts'), SHOP['src/shop.ts']!.replace('stockOf(code)', 'stockOf(code + "x")'));
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'legacy' });
    assert.ok(result.impacts.every(impact => impact.receivesChangedValue === undefined));
  } finally { repo.cleanup(); }
});
