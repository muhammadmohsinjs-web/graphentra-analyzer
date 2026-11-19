import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityImpact } from '@graphentra/analyzer';
import {
  buildCoverageItems,
  buildNotCovered,
  buildVerificationBlock,
  hasNoBehaviourChange,
  importListNames,
  innerParentId,
  planCoverage,
  type DecisionAnswer,
} from '../src/verifier';

// Phase V, V-13b: deterministic noise filter. Every skip rule has a twin that must still be asked (recall first).

const impact = (id: string, removed: string[], added: string[], diff = ''): EntityImpact => {
  const [file, name] = id.split('#');
  return {
    changedEntity: { id, name, kind: name === '<module>' ? 'module' : 'function', file, startLine: 1, endLine: 9 } as EntityImpact['changedEntity'],
    change: { file, changedLines: [1], removedCode: removed, addedCode: added, diff },
    directDependents: [],
    blastRadius: { totalAffectedEntities: 0, entities: [], paths: [] },
    terminalDependents: [],
  };
};
const same = (removed: string[], added: string[], diff = '') => hasNoBehaviourChange(impact('src/a.ts#f', removed, added, diff));

test('no behaviour change: the cases seen in the V-12 review are skipped', () => {
  assert.ok(same([], []), 'empty before and after');
  assert.ok(same(['  elements: ExcalidrawElement[],'], ['  elements: readonly ExcalidrawElement[],']), 'readonly');
  assert.ok(same(['    if ((defaults.level || 0) > this.level) {'], ['    if (((defaults.level as number) || 0) > this.level) {']), 'cast');
  assert.ok(same(['const { elements } = createScene();'], ['let { elements } = createScene();']), 'const to let');
  assert.ok(same(['import Library from "./library";', ''], []), 'import removed');
  assert.ok(same([], ['', '// taken from Radix UI', '/* note', ' * more */']), 'comments only');
  assert.ok(same([], ['export type P = Record<string, string>', '', 'export interface U {', '  protocol: string', '  onSelect?: (e: Event) => void;', '}']), 'type declarations');
  assert.ok(same([], ['  className?: string;']), 'type-only member');
  assert.ok(same(['): boolean => {', '  return elements.some((e) => s[e.id]);', '};'], ['): boolean =>', '  elements.some((e) => s[e.id]);']), 'arrow body formatting');
  assert.ok(same(["x('a')"], ['x("a")']), 'quote style');
});

test('behaviour changes are still asked about', () => {
  assert.equal(same(['return 1;'], ['return 2;']), false, 'a literal');
  assert.equal(same(['import "./Island.css";'], ['import "./Island.scss";']), false, 'side-effect import');
  assert.equal(same([], ['export { Types } from "./log.types";']), false, 're-export');
  assert.equal(same(['export { a as b };'], ['export { a };']), false, 'export alias');
  assert.equal(same(['default: break;'], ['default: return x;']), false, 'switch default is not a type member');
  assert.equal(same(['  count = 0;'], ['  count = 1;']), false, 'class field with an initializer');
  assert.equal(same(['if (a) {', '  return x;', '}'], ['if (a) return x;', 'y();']), false, 'extra statement');
});

test('bare names are skipped only inside an import list the diff shows', () => {
  const diff = ['@@ -1,6 +1,7 @@', ' import {', '   a,', '+  X,', ' } from "./x";', ' const PLUGINS = [', '   A,', '+  X,', ' ];'].join('\n');
  assert.deepEqual([...importListNames(diff).added], [['X,', 1]]);
  // `X,` is added twice: once to the import list (no behaviour), once to the array (behaviour). One occurrence must stay.
  assert.equal(hasNoBehaviourChange(impact('src/a.ts#<module>', [], ['X,', 'X,'], diff)), false);
  assert.equal(hasNoBehaviourChange(impact('src/a.ts#<module>', [], ['X,'], ['@@ -1,3 +1,4 @@', ' import {', '+  X,', ' } from "./x";'].join('\n'))), true);
  // The opener is outside the hunk: it could be `export {`, so the name counts as behaviour.
  assert.equal(hasNoBehaviourChange(impact('src/a.ts#<module>', [], ['X,'], ['@@ -4,2 +4,3 @@', '   a,', '+  X,', ' } from "./x";'].join('\n'))), false);
  // No diff at all: keep it.
  assert.equal(hasNoBehaviourChange(impact('src/a.ts#<module>', [], ['X,'])), false);
});

test('innerParentId folds only `>` inner functions', () => {
  assert.equal(innerParentId('src/App.js#App>onCopy'), 'src/App.js#App');
  assert.equal(innerParentId('src/a.ts#a>b>c'), 'src/a.ts#a>b');
  assert.equal(innerParentId('src/a.ts#<module>'), undefined);
  assert.equal(innerParentId('src/h.ts#History.undo'), undefined, 'class members are asked on their own');
});

test('planCoverage: skip, fold into the nearest asked parent, and ask the rest', () => {
  const impacts = [
    impact('src/App.js#App', ['a()'], ['b()']),
    impact('src/App.js#App>onCopy', ['c()'], ['d()']),
    impact('src/App.js#App>onCopy>inner', ['e()'], ['f()']),
    impact('src/x.ts#f', ['  e: T[],'], ['  e: readonly T[],']),
    impact('src/x.ts#f>g', ['return 1'], ['return 2']), // parent skipped: g is asked on its own
    impact('src/x.test.ts#t', ['a'], ['b']),
  ];
  const plan = planCoverage(impacts);
  assert.deepEqual(plan.skipped, ['src/x.ts#f']);
  assert.deepEqual(plan.ask.map(a => [a.impact.changedEntity.id, a.inner.map(i => i.changedEntity.id)]), [
    ['src/App.js#App', ['src/App.js#App>onCopy', 'src/App.js#App>onCopy>inner']],
    ['src/x.ts#f>g', []],
  ]);
  const items = buildCoverageItems(impacts, { summary: 's', keyChanges: ['k'], qaChecks: ['Verify x.'], uncertainty: [] });
  assert.match(items[0].input, /INNER FUNCTION, PART OF THIS CHANGE src\/App\.js#App>onCopy /);
});

test('verdicts: every production entity is accounted for, a folded child is listed once through its parent', () => {
  const impacts = [impact('src/App.js#App', ['a()'], ['b()']), impact('src/App.js#App>onCopy', ['c()'], ['d()']), impact('src/x.ts#f', [], [])];
  const items = buildCoverageItems(impacts, { summary: 's', keyChanges: ['k'], qaChecks: ['Verify x.'], uncertainty: [] });
  assert.equal(items.length, 1, 'one question for App and its inner function; the empty change is not asked');
  const answers = new Map<string, DecisionAnswer>([['coverage:src/App.js#App', { id: 'coverage:src/App.js#App', outcome: 'answer', probability: 0.1 }]]);
  const block = buildVerificationBlock(items, answers, 0.7, planCoverage(impacts).skipped);
  assert.deepEqual(block.entries.map(e => [e.entity, e.verdict, e.foldedInto ?? '-']), [
    ['src/App.js#App', 'not_covered', '-'],
    ['src/App.js#App>onCopy', 'not_covered', 'src/App.js#App'],
    ['src/x.ts#f', 'skipped', '-'],
  ]);
  assert.equal(block.notCovered, 1);
  assert.deepEqual(buildNotCovered(block, impacts).map(n => n.entity), ['src/App.js#App']);
});
