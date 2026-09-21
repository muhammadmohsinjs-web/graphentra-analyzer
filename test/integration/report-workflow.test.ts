import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { validateEvidenceEnvelope } from '@graphentra/analyzer';
import { runReport } from '../../tools/report';
test('local report preserves current evidence on missing context and injected provider failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'report-workflow-'));
  const previousExit = process.exitCode;
  try {
    const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, stdio: 'pipe' });
    git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export function a() { return 1; }');
    git(['add', '.']); git(['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export function a() { return 2; }');
    const args = ['--target', directory, '--working-tree'];
    await runReport(args, { environment: {}, loadEnvironment: false });
    assert.equal(process.exitCode, 1);
    const evidencePath = path.join(directory, '.graphentra/evidence.json');
    assert.equal(validateEvidenceEnvelope(JSON.parse(fs.readFileSync(evidencePath, 'utf8'))).valid, true);
    const contextPath = path.join(directory, '.graphentra/application-context.json');
    const context = JSON.stringify({ schemaVersion: '1.0', application: { name: 'Test', summary: 'Test', purpose: 'Test' }, domains: [], terminology: [], entityAnnotations: [], applicationFacts: [], unknowns: [] });
    fs.writeFileSync(contextPath, context);
    const modifiedAt = fs.statSync(contextPath).mtimeMs;
    const client: any = { chat: { completions: { create: () => { throw new Error('Injected offline provider failure'); } } } };
    await runReport(args, { environment: {}, loadEnvironment: false, llmOptions: { client } });
    assert.equal(process.exitCode, 1);
    assert.equal(fs.readFileSync(contextPath, 'utf8'), context);
    assert.equal(fs.statSync(contextPath).mtimeMs, modifiedAt);
    assert.equal(validateEvidenceEnvelope(JSON.parse(fs.readFileSync(evidencePath, 'utf8'))).valid, true);
  } finally { process.exitCode = previousExit; fs.rmSync(directory, { recursive: true, force: true }); }
});
