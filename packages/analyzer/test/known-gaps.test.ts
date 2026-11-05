import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { createRepo } from './helpers/git-fixture';

// These tests assert today's misses from impactbench/gaps/gaps.json. A failure here can be good news:
// if a fix made it fail, change the test to assert the new behavior and mark the gap as fixed.

test('GAP-001 a consumer downstream of a changed function receives the changed value', () => {
  // Reduced from excalidraw-11: normalizeText added to getSystemClipboard stripped the tabs tryParseSpreadsheet needs.
  const repo = createRepo();
  try {
    repo.commitFile('src/charts.ts', 'export const tryParseSpreadsheet = (text: string) => text.split("\\n").map((line) => line.trim().split("\\t"));\n');
    repo.commitFile('src/textElement.ts', 'export const normalizeText = (text: string) => text.replace(/\\t/g, "        ");\n');
    const clipboard = (body: string) => [
      'import { tryParseSpreadsheet } from "./charts";',
      'import { normalizeText } from "./textElement";',
      'const parsePotentialSpreadsheet = (text: string) => tryParseSpreadsheet(text);',
      `export const getSystemClipboard = (raw: string) => ${body};`,
      'export const parseClipboard = (raw: string) => {',
      '  const systemClipboard = getSystemClipboard(raw);',
      '  return parsePotentialSpreadsheet(systemClipboard);',
      '};',
      'export const unused = normalizeText;',
      '',
    ].join('\n');
    repo.commitFile('src/clipboard.ts', clipboard('raw.trim()'));
    fs.writeFileSync(path.join(repo.dir, 'src/clipboard.ts'), clipboard('normalizeText(raw).trim()'));

    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const flagged = new Set(result.impacts.flatMap(impact => [impact.changedEntity.id, ...impact.blastRadius.entities.map(entity => entity.id)]));
    assert.ok(flagged.has('src/clipboard.ts#getSystemClipboard'));
    assert.ok(flagged.has('src/clipboard.ts#parseClipboard'));

    // Fixed: the walk toward callers still misses the consumer, and value flow lists it.
    assert.ok(!flagged.has('src/charts.ts#tryParseSpreadsheet'));
    const received = result.impacts.flatMap(impact => (impact.receivesChangedValue ?? []).map(target => target.entity.id));
    assert.ok(received.includes('src/charts.ts#tryParseSpreadsheet'));
    const calls = (from: string, to: string) => result.technicalGraph!.relations.some(relation => relation.from === from && relation.to === to);
    assert.ok(calls('src/clipboard.ts#parseClipboard', 'src/clipboard.ts#parsePotentialSpreadsheet'));
    assert.ok(calls('src/clipboard.ts#parsePotentialSpreadsheet', 'src/charts.ts#tryParseSpreadsheet'));
  } finally { repo.cleanup(); }
});

test('GAP-004 a constant built by a call with a non-function argument is not an entity', () => {
  // Reduced from excalidraw-14: `const SendBackwardIcon = createIcon(<path />)` has no entity of its own.
  const repo = createRepo();
  try {
    repo.commitFile('src/icons.ts', [
      'const createIcon = (shape: string) => () => shape;',
      'export const BackIcon = createIcon("back");',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repo.dir, 'src/icons.ts'), [
      'const createIcon = (shape: string) => () => shape;',
      'export const BackIcon = createIcon("rotated");',
      '',
    ].join('\n'));
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const ids = result.technicalGraph!.entities.map(entity => entity.id);
    assert.ok(!ids.includes('src/icons.ts#BackIcon'));
  } finally { repo.cleanup(); }
});

test('GAP-005 a value stored in a shared object field does not reach the code that reads the field', () => {
  // Reduced from excalidraw-07: a tool set on appState is read by restoreAppState, with no call between them.
  const repo = createRepo();
  try {
    repo.commitFile('src/state.ts', 'export const state = { tool: "a" };\n');
    repo.commitFile('src/write.ts', "import { state } from './state';\nexport const setTool = () => { state.tool = 'a'; };\n");
    repo.commitFile('src/read.ts', "import { state } from './state';\nexport const restore = () => state.tool.trim();\n");
    fs.writeFileSync(path.join(repo.dir, 'src/write.ts'), "import { state } from './state';\nexport const setTool = () => { state.tool = 'b'; };\n");
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    const flagged = result.impacts.flatMap(impact => [impact.changedEntity.id, ...impact.blastRadius.entities.map(entity => entity.id),
      ...(impact.receivesChangedValue ?? []).map(target => target.entity.id)]);
    assert.ok(flagged.includes('src/write.ts#setTool'));
    assert.ok(!flagged.includes('src/read.ts#restore'));
  } finally { repo.cleanup(); }
});
