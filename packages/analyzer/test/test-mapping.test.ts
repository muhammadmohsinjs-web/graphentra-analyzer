import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';
import type { Entity } from '../src/contracts';
import { extractTests } from '../src/test-mapping';

function run(sources: Record<string, string>, extra: { isTestFile?: (p: string) => boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-mapping-'));
  const files: string[] = [];
  for (const [name, text] of Object.entries(sources)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    files.push(full);
  }
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, noEmit: true,
  });
  const checker = program.getTypeChecker();
  const symbolToEntity = new Map<ts.Symbol, Entity>();
  for (const file of files) {
    if (file.includes('.test.') || file.includes('.spec.') || file.includes('cypress')) continue;
    const sf = program.getSourceFile(file)!;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    for (const exp of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      symbolToEntity.set(exp, { id: `ent:${path.basename(file)}:${exp.name}` } as unknown as Entity);
    }
  }
  const exec = () => extractTests({
    program, checker, symbolToEntity, files, toProjectPath: f => path.relative(dir, f).split(path.sep).join('/'), ...extra,
  });
  return { exec };
}

const SRC = {
  'src/a.ts': 'export function alpha() { return 1; }\nexport function beta() { return 2; }\nexport function gamma() { return 3; }\nexport default function delta() { return 4; }\n',
};

test('detects frameworks', () => {
  const r = run({
    ...SRC,
    'a.test.ts': "import { it } from '@jest/globals';\nit('x', () => {});\n",
    'b.test.ts': "import { it } from 'vitest';\nit('x', () => {});\n",
    'c.test.ts': "import { it } from 'node:test';\nit('x', () => {});\n",
    'd.spec.ts': "import { test } from '@playwright/test';\ntest('x', async () => {});\n",
    'cypress/e.cy.ts': "it('x', () => { cy.get('a'); });\n",
    'f.test.ts': "it('x', () => {});\n",
    'g.test.ts': "it('x', () => { jest.fn(); });\n",
  }).exec();
  const byFile = Object.fromEntries(r.tests.map(t => [t.file, t.framework]));
  assert.deepEqual(byFile, {
    'a.test.ts': 'jest', 'b.test.ts': 'vitest', 'c.test.ts': 'node-test', 'd.spec.ts': 'playwright',
    'cypress/e.cy.ts': 'cypress', 'f.test.ts': 'unknown', 'g.test.ts': 'jest',
  });
});

test('nested suites, duplicates, modifiers, each, dynamic names', () => {
  const { tests } = run({
    ...SRC,
    'n.test.ts': [
      "describe('A', () => {",
      "  describe('B', () => {",
      "    it('works', () => {});",
      "    it('works', () => {});",
      "    it.only('works', () => {});",
      '  });',
      "  context('C', () => { specify('s', () => {}); });",
      "  it.skip('sk', () => {});",
      "  test.each([1, 2])('each %i', () => {});",
      '  it(`tpl ${1}`, () => {});',
      '});',
      "test('top', () => {});",
    ].join('\n'),
  }).exec();
  assert.deepEqual(tests.map(t => t.id), [
    'test:n.test.ts#A > <dynamic>',
    'test:n.test.ts#A > B > works',
    'test:n.test.ts#A > B > works#2',
    'test:n.test.ts#A > B > works#3',
    'test:n.test.ts#A > C > s',
    'test:n.test.ts#A > each %i',
    'test:n.test.ts#A > sk',
    'test:n.test.ts#top',
  ]);
  assert.equal(tests.find(t => t.id.endsWith('works#2'))!.line, 4);
});

test('covers entities directly, via aliases, hooks and top level', () => {
  const r = run({
    ...SRC,
    'c.test.ts': [
      "import { alpha as a, beta } from './src/a';",
      "import delta from './src/a';",
      "import * as ns from './src/a';",
      "const top = gamma0();",
      'function gamma0() { return ns.gamma(); }',
      "describe('S', () => {",
      '  beforeEach(() => { delta(); });',
      "  it('one', () => { a(); });",
      "  it('two', () => { beta(); });",
      '});',
    ].join('\n'),
  }).exec();
  const cov = (id: string) => r.coversEntities.filter(e => e.testId.endsWith(id)).map(e => e.entityId.split(':').pop());
  assert.deepEqual(cov('S > one'), ['alpha', 'default', 'gamma']);
  assert.deepEqual(cov('S > two'), ['beta', 'default', 'gamma']);
});

test('visits routes from goto and cy.visit', () => {
  const r = run({
    ...SRC,
    'e.spec.ts': [
      "import { test } from '@playwright/test';",
      "test('a', async ({ page }) => {",
      "  await page.goto('http://localhost:3000/orders?x=1');",
      '  await page.goto(`/users/${1}/edit`);',
      '  await page.goto(`/plain`);',
      '});',
    ].join('\n'),
    'cypress/v.cy.ts': "it('v', () => { cy.visit('/home'); });\n",
  }).exec();
  assert.deepEqual(r.visitsRoutes, [
    { testId: 'test:cypress/v.cy.ts#v', route: '/home' },
    { testId: 'test:e.spec.ts#a', route: '/orders' },
    { testId: 'test:e.spec.ts#a', route: '/plain' },
    { testId: 'test:e.spec.ts#a', route: '/users/:param/edit' },
  ]);
});

test('isTestFile option and determinism', () => {
  const sources = { ...SRC, 'custom.ts': "it('x', () => { alphaCall(); });\nfunction alphaCall() {}\n" };
  const first = run(sources, { isTestFile: p => p === 'custom.ts' }).exec();
  const again = run(sources, { isTestFile: p => p === 'custom.ts' }).exec();
  assert.equal(first.tests.length, 1);
  assert.deepEqual(first, again);
  assert.equal(run(sources).exec().tests.length, 0);
});
