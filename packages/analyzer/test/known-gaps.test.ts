import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { createRepo } from './helpers/git-fixture';

// These tests assert today's misses from impactbench/gaps/gaps.json. A failure here can be good news:
// if a fix made it fail, change the test to assert the new behavior and mark the gap as fixed.

test('GAP-001 a consumer downstream of a changed function is not in the impact', () => {
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

    // The miss: the consumer is listed nowhere, although every link to it is in the graph.
    assert.ok(!flagged.has('src/charts.ts#tryParseSpreadsheet'));
    const calls = (from: string, to: string) => result.technicalGraph!.relations.some(relation => relation.from === from && relation.to === to);
    assert.ok(calls('src/clipboard.ts#parseClipboard', 'src/clipboard.ts#parsePotentialSpreadsheet'));
    assert.ok(calls('src/clipboard.ts#parsePotentialSpreadsheet', 'src/charts.ts#tryParseSpreadsheet'));
  } finally { repo.cleanup(); }
});
