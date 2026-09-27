import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { validateEvidenceEnvelope } from '@graphentra/analyzer';
import { runReport } from '../../tools/report';
import { createFakeLlm } from '../../packages/reporting/test/helpers/fake-llm';
import { applyPaymentThresholdChange, createWebAppRepository } from '../../packages/reporting/test/helpers/web-app';
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

test('onboarding generates a v2 context once, reports where to test, and refreshes incrementally', async t => {
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const repo = createWebAppRepository();
  const previousExit = process.exitCode;
  try {
    process.exitCode = undefined;
    applyPaymentThresholdChange(repo.edit);
    const fake = createFakeLlm();
    const reportFile = path.join(repo.dir, 'qa-report.md');
    const args = ['--target', repo.dir, '--working-tree', '--report', reportFile];
    await runReport([...args, '--generate-context'], { environment: {}, loadEnvironment: false, llmOptions: { client: fake.client, model: 'offline' } });
    assert.equal(process.exitCode, undefined);
    const graphentra = path.join(repo.dir, '.graphentra');
    const context = JSON.parse(fs.readFileSync(path.join(graphentra, 'application-context.json'), 'utf8'));
    assert.equal(context.schemaVersion, '2.0');
    assert.ok(context.surfaces.length >= 4);
    const map = JSON.parse(fs.readFileSync(path.join(graphentra, 'application-map.json'), 'utf8'));
    assert.ok(map.surfaces.some((surface: { id: string }) => surface.id === 'api:POST /api/orders'));
    const analysis = JSON.parse(fs.readFileSync(path.join(graphentra, 'analysis.json'), 'utf8'));
    assert.ok(analysis.qaReport.testAreas[0].surfaceIds.includes('api:POST /api/orders'));
    assert.match(fs.readFileSync(reportFile, 'utf8'), /Where and what to test/);

    // A second run reuses the context without any context-generation request.
    const contextCalls = () => fake.calls.filter(call => call.schema.startsWith('graphentra_context')).length;
    const afterOnboarding = contextCalls();
    await runReport(args, { environment: {}, loadEnvironment: false, llmOptions: { client: fake.client, model: 'offline' } });
    assert.equal(contextCalls(), afterOnboarding);

    // Refresh re-describes only the function changed since onboarding.
    repo.edit('src/shared/pricing.ts', 'toFixed(2)', 'toFixed(3)');
    const beforeRefresh = fake.calls.length;
    await runReport([...args, '--refresh-context'], { environment: {}, loadEnvironment: false, llmOptions: { client: fake.client, model: 'offline' } });
    assert.equal(process.exitCode, undefined);
    const refreshed = fake.calls.slice(beforeRefresh).filter(call => call.schema === 'graphentra_context_module')
      .flatMap(call => call.user.entitiesToDescribe.map((entity: { id: string }) => entity.id));
    assert.deepEqual(refreshed, ['src/shared/pricing.ts#formatPrice']);
    assert.ok(fs.existsSync(path.join(graphentra, 'application-context.previous.json')));
  } finally { process.exitCode = previousExit; repo.cleanup(); }
});
