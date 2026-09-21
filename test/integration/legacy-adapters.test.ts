import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { request } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ANALYZER_VERSION,
  analyzeRepository,
  createRepositoryContext,
  createVisualizerServer,
  parseCliOptions,
  writeJsonArtifact,
} from '../../src/index';

test('integration: root legacy entrypoint re-exports analyzer and reporting contracts', () => {
  assert.equal(typeof analyzeRepository, 'function');
  assert.equal(typeof createRepositoryContext, 'function');
  assert.equal(typeof parseCliOptions, 'function');
  assert.equal(typeof createVisualizerServer, 'function');
  assert.equal(ANALYZER_VERSION, '0.4.0');
});

test('integration: end-to-end analyzer to visualizer flow using only new evidence.json', async () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-e2e-'));
  const dir = fs.realpathSync(rawDir);
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'user.email', 'test@example.com']);

    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      'export function helper(): number { return 1; }\nexport function processOrder(): number { return helper(); }\n',
      'utf8',
    );
    git(['add', '.']);
    git(['commit', '-m', 'Initial']);

    // Modify helper
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      'export function helper(): number { return 2; }\nexport function processOrder(): number { return helper(); }\n',
      'utf8',
    );

    // 1. Run analyzer producing evidence
    const result = analyzeRepository({
      target: dir,
      comparison: { mode: 'working-tree' },
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(result.changedEntities.length, 1);
    assert.equal(result.changedEntities[0].entity.id, 'src/service.ts#helper');

    // 2. Write ONLY evidence.json (no legacy analysis.json or separate technical-graph.json)
    const outDir = path.join(dir, '.graphentra');
    writeJsonArtifact(outDir, 'evidence.json', result.evidence);

    // 3. Start visualizer server pointing to target
    const server = createVisualizerServer({ target: dir });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;

    try {
      // 4. Fetch /api/data
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/api/data', method: 'GET', agent: false },
          res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, body: data }));
          },
        );
        req.on('error', reject);
        req.end();
      });

      assert.equal(response.status, 200);
      const parsed = JSON.parse(response.body);

      // Embedded graph and recorded impacts loaded directly from evidence.json
      assert.ok(parsed.graph);
      assert.ok(parsed.analysis);
      assert.ok(parsed.evidence);
      assert.equal(parsed.evidence.artifactKind, 'graphentra-evidence');
      assert.equal(parsed.analysis.changedEntities.length, 1);
      assert.equal(parsed.analysis.changedEntities[0].entity.id, 'src/service.ts#helper');
      assert.equal(parsed.analysis.impacts.length, 1);
      assert.equal(parsed.analysis.impacts[0].directDependents[0].id, 'src/service.ts#processOrder');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
