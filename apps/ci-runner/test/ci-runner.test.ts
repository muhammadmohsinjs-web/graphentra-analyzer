import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { DeterministicEvidence } from '@graphentra/analyzer';
import {
  SubmissionClientError,
  analyzeAndSubmit,
  computeSubmissionIdempotencyKey,
  resubmitEvidenceFile,
  submitEvidence,
} from '../src/index';

interface MockRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function createMockServer(
  handler: (req: MockRequest, res: ServerResponse) => void,
): Promise<{ server: Server; url: string; requests: MockRequest[] }> {
  const requests: MockRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const mockReq: MockRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      requests.push(mockReq);
      handler(mockReq, res);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

function makeSampleEvidence(): DeterministicEvidence {
  return {
    artifactKind: 'graphentra-evidence',
    schemaVersion: '2.0',
    analyzerVersion: '0.4.0',
    target: { targetPath: '.' },
    options: { excludePaths: [], sourcePolicy: 'git-tracked' },
    comparison: {
      mode: 'commit',
      resolvedBaseSha: '1111111111111111111111111111111111111111',
      resolvedHeadSha: '2222222222222222222222222222222222222222',
      comparedTo: '`HEAD`',
    },
    sourceState: {
      contentIdentity: '0'.repeat(64),
      checkoutSha: '2222222222222222222222222222222222222222',
      isTrackedDirty: false,
      untrackedSourcePolicy: 'excluded',
    },
    outcome: 'completed',
    technicalGraph: {
      schemaVersion: '1.0',
      repository: { targetPath: '.', headSha: '2222222222222222222222222222222222222222', analyzerVersion: '0.4.0' },
      capabilities: { language: 'typescript', entityKinds: ['function'], relationTypes: ['CALLS'], maxBlastDepth: 6 },
      analyzedFiles: ['src/app.ts'],
      entities: [{ id: 'src/app.ts#calc', kind: 'function', name: 'calc', file: 'src/app.ts', startLine: 1, endLine: 3 }],
      relations: [],
    },
    changedFiles: [],
    changedEntities: [{ entity: { id: 'src/app.ts#calc', kind: 'function', name: 'calc', file: 'src/app.ts', startLine: 1, endLine: 3 }, change: { file: 'src/app.ts', changedLines: [2], addedCode: [], removedCode: [], diff: '' } }],
    impacts: [{ changedEntity: { id: 'src/app.ts#calc', kind: 'function', name: 'calc', file: 'src/app.ts', startLine: 1, endLine: 3 }, change: { file: 'src/app.ts', changedLines: [2], addedCode: [], removedCode: [], diff: '' }, directDependents: [], blastRadius: { totalAffectedEntities: 0, entities: [], paths: [] }, terminalDependents: [] }],
    diagnostics: [],
    limitations: [],
  };
}

function createRepo(name: string = 'graphentra-ci-test-') {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const dir = fs.realpathSync(rawDir);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);

  const commitFile = (relPath: string, content: string, msg: string = 'commit') => {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    git(['add', relPath]);
    git(['commit', '-m', msg]);
    return git(['rev-parse', 'HEAD']);
  };

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { dir, git, commitFile, cleanup };
}

test('ci-runner: submits valid evidence to mock backend and receives 202 queued', async () => {
  const { server, url, requests } = await createMockServer((req, res) => {
    assert.equal(req.url, '/v1/analysis-runs');
    assert.equal(req.headers['authorization'], 'Bearer test-token-123');
    assert.ok(req.headers['idempotency-key']);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'run_test_999', status: 'queued' }));
  });

  try {
    const evidence = makeSampleEvidence();
    const result = await submitEvidence({
      backendUrl: url,
      token: 'test-token-123',
      payload: {
        repository: { name: 'acme/webapp' },
        pullRequest: { number: 42 },
        comparisonPolicy: 'merge-base-to-head',
        evidence,
      },
      allowHttpForTesting: true,
    });

    assert.equal(result.id, 'run_test_999');
    assert.equal(result.status, 'queued');
    assert.equal(requests.length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ci-runner: reuses stable idempotency key across retries', async () => {
  const idempotencyKeys: string[] = [];
  let attempt = 0;

  const { server, url } = await createMockServer((req, res) => {
    attempt++;
    idempotencyKeys.push(req.headers['idempotency-key'] as string);
    if (attempt === 1) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
    } else {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'run_retry_1', status: 'queued' }));
    }
  });

  try {
    const evidence = makeSampleEvidence();
    const result = await submitEvidence({
      backendUrl: url,
      token: 'test-token',
      payload: {
        repository: { name: 'acme/webapp' },
        pullRequest: { number: 42 },
        comparisonPolicy: 'merge-base-to-head',
        evidence,
      },
      allowHttpForTesting: true,
      retryDelayMs: 10,
    });

    assert.equal(result.id, 'run_retry_1');
    assert.equal(attempt, 2);
    assert.equal(idempotencyKeys.length, 2);
    assert.equal(idempotencyKeys[0], idempotencyKeys[1], 'Retried request must reuse exact same idempotency key');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ci-runner: permanent errors (401, 422) fail immediately without retry', async () => {
  let callCount = 0;
  const { server, url } = await createMockServer((req, res) => {
    callCount++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized credential' }));
  });

  try {
    const evidence = makeSampleEvidence();
    await assert.rejects(
      () =>
        submitEvidence({
          backendUrl: url,
          token: 'bad-token',
          payload: {
            repository: { name: 'acme/webapp' },
            comparisonPolicy: 'base-to-head',
            evidence,
          },
          allowHttpForTesting: true,
          maxRetries: 3,
        }),
      (err: any) => {
        return err instanceof SubmissionClientError && err.statusCode === 401 && err.isPermanent;
      },
    );

    assert.equal(callCount, 1, 'Must not retry permanent 401 error');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ci-runner: timeout aborts stalled request', async () => {
  const { server, url } = await createMockServer((_req, _res) => {
    // Deliberately stall response
  });

  try {
    const evidence = makeSampleEvidence();
    await assert.rejects(
      () =>
        submitEvidence({
          backendUrl: url,
          token: 'token',
          payload: {
            repository: { name: 'acme/webapp' },
            comparisonPolicy: 'base-to-head',
            evidence,
          },
          allowHttpForTesting: true,
          timeoutMs: 50,
          maxRetries: 1,
        }),
      /timed out/,
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ci-runner: cross-origin redirect strips authorization credentials', async () => {
  let crossHostRequestHeaders: Record<string, any> = {};

  // Target server
  const { server: serverB, url: urlB } = await createMockServer((req, res) => {
    crossHostRequestHeaders = req.headers;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'run_redirected', status: 'queued' }));
  });

  // Initial server that redirects to serverB
  const { server: serverA, url: urlA } = await createMockServer((req, res) => {
    res.writeHead(307, { Location: `${urlB}/v1/analysis-runs` });
    res.end();
  });

  try {
    const evidence = makeSampleEvidence();
    const result = await submitEvidence({
      backendUrl: urlA,
      token: 'sensitive-secret-token',
      payload: {
        repository: { name: 'acme/webapp' },
        comparisonPolicy: 'base-to-head',
        evidence,
      },
      allowHttpForTesting: true,
    });

    assert.equal(result.id, 'run_redirected');
    // Authorization must have been stripped on cross-origin redirect
    assert.equal(
      crossHostRequestHeaders['authorization'],
      undefined,
      'Authorization header must be stripped when redirected to another host/port',
    );
  } finally {
    await new Promise<void>(resolve => serverA.close(() => resolve()));
    await new Promise<void>(resolve => serverB.close(() => resolve()));
  }
});

test('ci-runner: resubmitEvidenceFile submits existing valid file without running analyzer', async () => {
  const { server, url, requests } = await createMockServer((req, res) => {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'run_resubmit_7', status: 'queued' }));
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-resubmit-'));
  const filePath = path.join(tmpDir, 'evidence.json');
  fs.writeFileSync(filePath, JSON.stringify(makeSampleEvidence(), null, 2), 'utf8');

  try {
    const res = await resubmitEvidenceFile({
      evidencePath: filePath,
      repository: { name: 'acme/webapp' },
      backendUrl: url,
      token: 'test-token',
      allowHttpForTesting: true,
    });

    assert.equal(res.id, 'run_resubmit_7');
    assert.equal(requests.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ci-runner: analyzeAndSubmit saves evidence even if submission fails', async () => {
  const { server, url } = await createMockServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server Crash');
  });

  const repo = createRepo('graphentra-ci-fail-');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-saved-out-'));
  try {
    repo.commitFile('src/a.ts', 'export function a() { return 1; }', 'c1');
    const evidencePath = path.join(outDir, 'my-evidence.json');

    await assert.rejects(
      () =>
        analyzeAndSubmit({
          target: repo.dir,
          comparison: { mode: 'working-tree' },
          repository: { name: 'acme/webapp' },
          backendUrl: url,
          token: 'token',
          outputEvidencePath: evidencePath,
          allowHttpForTesting: true,
        }),
      /Submission failed/,
    );

    // Verify evidence file was preserved on disk despite submission failure
    assert.equal(fs.existsSync(evidencePath), true, 'Evidence file must be saved on disk despite submission failure');
    const saved = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(saved.artifactKind, 'graphentra-evidence');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ci-runner: analyzer failure never attempts submission and does not submit old evidence', async () => {
  let backendCalled = false;
  const { server, url } = await createMockServer((_req, res) => {
    backendCalled = true;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'should_not_happen', status: 'queued' }));
  });

  try {
    await assert.rejects(
      () =>
        analyzeAndSubmit({
          target: '/non/existent/target/path/12345',
          comparison: { mode: 'working-tree' },
          repository: { name: 'acme/webapp' },
          backendUrl: url,
          token: 'token',
          allowHttpForTesting: true,
        }),
      /Directory does not exist/,
    );

    assert.equal(backendCalled, false, 'Backend must not be contacted when analysis fails');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
