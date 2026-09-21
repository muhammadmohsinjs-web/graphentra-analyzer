import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeRepository, computeDeterministicEvidenceIdentity } from '@graphentra/analyzer';
import { generateQAReport } from '../src/report-generator';
test('report boundary validates context before provider calls and binds JSON and Markdown identity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'report-boundary-'));
  try {
    const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, stdio: 'pipe' });
    git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export function a() { return 1; }');
    git(['add', '.']); git(['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export function a() { return 2; }');
    const evidence = analyzeRepository({ target: directory, comparison: { mode: 'working-tree' } }).evidence;
    let calls = 0;
    const client: any = { chat: { completions: { create: () => {
      calls++;
      return { withResponse: async () => ({ data: { choices: [{ message: { content: JSON.stringify({
        summary: 'The displayed value changed.', keyChanges: ['The displayed value is higher.'], qaChecks: ['Verify the displayed value is correct.'], uncertainty: [],
      }) } }] }, request_id: 'fake' }) };
    } } } };
    for (const context of [undefined, null, {}, { schemaVersion: '99' }]) await assert.rejects(generateQAReport(evidence, context, { client }));
    assert.equal(calls, 0);
    const context = { schemaVersion: '1.0', application: { name: 'Test', summary: 'Test', purpose: 'Test' }, domains: [], terminology: [], entityAnnotations: [], applicationFacts: [], unknowns: [] };
    const result = await generateQAReport(evidence, context, { client, model: 'offline' });
    assert.equal(calls, 1);
    assert.equal(result.evidenceIdentity, computeDeterministicEvidenceIdentity(evidence));
    assert.ok(result.markdownReport.includes(`Evidence Identity: ${result.evidenceIdentity}`));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
