import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createVisualizerServer } from '../src/visualize';

const graph = {
  schemaVersion: '1.0',
  repository: { headSha: 'abc123', generatedAt: '2020-01-01T00:00:00.000Z' },
  entities: [], relations: [],
};
const analysis = {
  schemaVersion: '1.1', repository: { headSha: 'abc123' },
  changedFiles: [], changedEntities: [], impacts: [],
};
const context = { schemaVersion: '1.0', application: { name: 'Example' }, domains: [], entityAnnotations: [] };

async function fixture(t: TestContext, artifacts: Record<string, unknown> = {
  'technical-graph.json': graph, 'analysis.json': analysis, 'application-context.json': context,
}) {
  const target = await mkdtemp(path.join(tmpdir(), 'graphentra-visualizer-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const directory = path.join(target, '.graphentra');
  const visualizerDirectory = path.join(target, 'visualizer');
  await mkdir(directory);
  await mkdir(visualizerDirectory);
  for (const [filename, data] of Object.entries(artifacts)) {
    await writeFile(path.join(directory, filename), typeof data === 'string' ? data : JSON.stringify(data));
  }
  for (const filename of ['index.html', 'app.js', 'model.mjs', 'styles.css']) {
    await writeFile(path.join(visualizerDirectory, filename), `fixture ${filename}`);
  }
  await writeFile(path.join(target, 'secret.txt'), 'must not be served');
  const server = createVisualizerServer({ target, visualizerDirectory });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const get = (url = '/api/data', headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: url, method, headers, agent: false }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  return { target, directory, port, get };
}

test('serves valid artifacts and warns that matching SHAs do not prove working-tree alignment', async t => {
  const { get } = await fixture(t);
  const response = await get();
  assert.equal(response.status, 200);
  const data = JSON.parse(response.text);
  assert.deepEqual(data.graph, graph);
  assert.deepEqual(data.analysis, analysis);
  assert.deepEqual(data.context, context);
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0], /working-tree alignment/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('missing graph returns a helpful 404 even if optional artifacts exist', async t => {
  const { get } = await fixture(t, { 'analysis.json': analysis });
  const response = await get();
  assert.equal(response.status, 404);
  assert.match(JSON.parse(response.text).error, /Missing technical-graph.json.*Run the analyzer/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('missing optional artifacts return null and warnings', async t => {
  const { get } = await fixture(t, { 'technical-graph.json': graph });
  const response = await get();
  assert.equal(response.status, 200);
  const data = JSON.parse(response.text);
  assert.equal(data.analysis, null);
  assert.equal(data.context, null);
  assert.deepEqual(data.warnings, ['Optional analysis.json is missing.', 'Optional application-context.json is missing.']);
});

test('malformed optional JSON is ignored without losing the graph', async t => {
  const { get } = await fixture(t, {
    'technical-graph.json': graph, 'analysis.json': '{', 'application-context.json': 'not json',
  });
  const response = await get();
  assert.equal(response.status, 200);
  const data = JSON.parse(response.text);
  assert.deepEqual(data.graph, graph);
  assert.equal(data.analysis, null);
  assert.equal(data.context, null);
  assert.equal(data.warnings.length, 2);
  assert.match(data.warnings.join(' '), /analysis.json.*ignored.*application-context.json.*ignored/);
});

test('rejects invalid required schemas and structures', async t => {
  const { directory, get } = await fixture(t);
  for (const value of ['{', null, { ...graph, schemaVersion: '99' }, { ...graph, entities: {} }]) {
    await writeFile(path.join(directory, 'technical-graph.json'), typeof value === 'string' ? value : JSON.stringify(value));
    const response = await get();
    assert.equal(response.status, 422);
    assert.match(JSON.parse(response.text).error, /Regenerate it with the analyzer/);
  }
});

test('ignores unsupported optional versions and invalid structures', async t => {
  const { get } = await fixture(t, {
    'technical-graph.json': graph,
    'analysis.json': { ...analysis, schemaVersion: '99' },
    'application-context.json': { ...context, domains: null },
  });
  const data = JSON.parse((await get()).text);
  assert.equal(data.analysis, null);
  assert.equal(data.context, null);
  assert.match(data.warnings[0], /schemaVersion/);
  assert.match(data.warnings[1], /Expected arrays/);
});

test('excludes analysis from a different headSha', async t => {
  const { get } = await fixture(t, {
    'technical-graph.json': graph,
    'analysis.json': { ...analysis, repository: { headSha: 'different' } },
    'application-context.json': context,
  });
  const data = JSON.parse((await get()).text);
  assert.equal(data.analysis, null);
  assert.deepEqual(data.context, context);
  assert.match(data.warnings[0], /headSha does not match.*ignored/);
});

test('warns on stale analysis using its mtime and reloads artifacts on each request', async t => {
  const { directory, get } = await fixture(t);
  const file = path.join(directory, 'analysis.json');
  const old = new Date('2019-01-01T00:00:00Z');
  await utimes(file, old, old);
  const stale = JSON.parse((await get()).text);
  assert.deepEqual(stale.analysis, analysis);
  assert.match(stale.warnings.join(' '), /potentially stale/);
  const newer = new Date('2021-01-01T00:00:00Z');
  await utimes(file, newer, newer);
  assert.doesNotMatch(JSON.parse((await get()).text).warnings.join(' '), /potentially stale/);
});

test('serves only the four allowlisted assets, with MIME types and security headers', async t => {
  const { get } = await fixture(t);
  for (const [url, filename, mime] of [
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'],
    ['/model.mjs', 'model.mjs', 'text/javascript'], ['/styles.css', 'styles.css', 'text/css'],
  ]) {
    const response = await get(url);
    assert.equal(response.status, 200);
    assert.equal(response.text, `fixture ${filename}`);
    assert.equal(response.headers['content-type'], `${mime}; charset=utf-8`);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const policy = response.headers['content-security-policy'];
    assert.ok(typeof policy === 'string');
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /object-src 'none'/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const url of ['/index.html', '/secret.txt', '/.graphentra/technical-graph.json', '/src/index.ts',
    '/../secret.txt', '/%2e%2e/secret.txt', '/foo/../app.js', '//app.js', '/%61pp.js', '/app.js/extra',
    '/..\\secret.txt', '/__proto__', '/api/data/../secret.txt']) {
    const response = await get(url);
    assert.equal(response.status, 404, url);
    assert.doesNotMatch(response.text, /must not be served/);
  }
  assert.equal((await get('/app.js?v=1')).status, 200);
});

test('rejects unexpected hosts and cross-origin requests, including on errors and assets', async t => {
  const { get, port } = await fixture(t);
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', 'localhost:1', `127.0.0.1:${port}.evil.example`]) {
    const response = await get('/api/data', { Host: host });
    assert.equal(response.status, 403, host);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(response.headers['content-security-policy']);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const origin of ['https://evil.example', 'null', `http://localhost:${port}`, 'http://127.0.0.1:1']) {
    assert.equal((await get('/app.js', { Origin: origin })).status, 403, origin);
  }
  assert.equal((await get('/api/data', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get('/api/data', { Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await get('/api/data', { Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status, 200);
  const response = await get('/api/data', {}, 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET');
});

test('CLI rejects malformed ports, unknown options, and extra targets', async () => {
  for (const args of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', '4.5'],
    ['--port', '4173junk'], ['--port=abc'], ['--port=4173', '--port=4174'], ['--host', '0.0.0.0'], ['one', 'two']]) {
    await assert.rejects(promisify(execFile)(process.execPath,
      ['--import', 'tsx', path.join(__dirname, '../src/visualize.ts'), ...args]),
    (error: unknown) => {
      const result = error as Error & { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Usage: npm run visualize/);
      return true;
    });
  }
});

test('CLI reports listen failures cleanly', async t => {
  const { port, target } = await fixture(t);
  await assert.rejects(promisify(execFile)(process.execPath,
    ['--import', 'tsx', path.join(__dirname, '../src/visualize.ts'), target, '--port', String(port)]),
  (error: unknown) => {
    const result = error as Error & { code: number; stderr: string };
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Cannot start visualizer.*EADDRINUSE/);
    return true;
  });
});

test('visualizer prefers evidence.json and serves embedded graph and recorded impacts', async t => {
  const validEvidence = {
    artifactKind: 'graphentra-evidence',
    schemaVersion: '2.0',
    analyzerVersion: '0.4.0',
    target: { targetPath: '.' },
    comparison: { mode: 'commit', resolvedBaseSha: '111', resolvedHeadSha: '222', comparedTo: '`HEAD`' },
    sourceState: { checkoutSha: '222', isTrackedDirty: false, untrackedSourcePolicy: 'excluded' },
    outcome: 'completed',
    technicalGraph: {
      schemaVersion: '1.0',
      repository: { targetPath: '.', headSha: '222', analyzerVersion: '0.4.0' },
      capabilities: { language: 'typescript', entityKinds: ['function'], relationTypes: ['CALLS'], maxBlastDepth: 6 },
      analyzedFiles: ['src/app.ts'],
      entities: [{ id: 'src/app.ts#run', kind: 'function', name: 'run', file: 'src/app.ts', startLine: 1, endLine: 3 }],
      relations: [],
    },
    changedFiles: [],
    changedEntities: [{ entity: { id: 'src/app.ts#run', kind: 'function', name: 'run', file: 'src/app.ts', startLine: 1, endLine: 3 }, change: { file: 'src/app.ts', changedLines: [2], addedCode: [], removedCode: [], diff: '' } }],
    impacts: [{ changedEntity: { id: 'src/app.ts#run', kind: 'function', name: 'run', file: 'src/app.ts', startLine: 1, endLine: 3 }, change: { file: 'src/app.ts', changedLines: [2], addedCode: [], removedCode: [], diff: '' }, directDependents: [], blastRadius: { totalAffectedEntities: 0, entities: [], paths: [] }, terminalDependents: [] }],
    diagnostics: [],
    limitations: [],
  };

  const { get } = await fixture(t, { 'evidence.json': validEvidence });
  const response = await get();
  assert.equal(response.status, 200);
  const data = JSON.parse(response.text);
  assert.ok(data.evidence);
  assert.equal(data.evidence.artifactKind, 'graphentra-evidence');
  assert.equal(data.graph.repository.headSha, '222');
  assert.equal(data.analysis.changedEntities.length, 1);
});

test('visualizer rejects invalid evidence.json with 422 and does not fall back to analysis.json', async t => {
  const invalidEvidence = { artifactKind: 'wrong-kind' };
  const legacyGraph = {
    schemaVersion: '1.0',
    repository: { headSha: 'abc123', generatedAt: '2020-01-01T00:00:00.000Z' },
    entities: [],
    relations: [],
  };
  const legacyAnalysis = {
    schemaVersion: '1.1',
    repository: { headSha: 'abc123' },
    changedFiles: [],
    changedEntities: [],
    impacts: [],
  };

  const { get } = await fixture(t, {
    'evidence.json': invalidEvidence,
    'technical-graph.json': legacyGraph,
    'analysis.json': legacyAnalysis,
  });

  const response = await get();
  assert.equal(response.status, 422);
  const data = JSON.parse(response.text);
  assert.match(data.error, /Cannot load evidence\.json/);
});
