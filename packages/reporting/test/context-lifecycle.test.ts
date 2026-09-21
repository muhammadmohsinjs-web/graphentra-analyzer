import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { TechnicalGraph } from '@graphentra/analyzer';
import {
  type ApplicationContext,
  generateImpactReport,
  getOrCreateApplicationContext,
  validateApplicationContext,
} from '../src/index';

test('reporting separation: importing reporting does not load .env into process.env', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-dotenv-tripwire-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TRIPWIRE_SECRET_KEY=should_not_be_loaded\n', 'utf8');

    const checkScript = `
      const reporting = require(${JSON.stringify(path.resolve(__dirname, '../dist/index.js'))});
      if (process.env.TRIPWIRE_SECRET_KEY !== undefined) {
        process.exit(101);
      }
      process.exit(0);
    `;

    const res = spawnSync(process.execPath, ['-e', checkScript], {
      cwd: tmpDir,
      encoding: 'utf8',
    });

    assert.equal(
      res.status,
      0,
      `Importing reporting loaded .env into process.env! Exit code: ${res.status}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reporting separation: separate calls can use different injected models and clients', async () => {
  const requestedModels: string[] = [];

  const createMockClient = (modelName: string) => {
    return {
      chat: {
        completions: {
          create: (req: any) => {
            requestedModels.push(req.model);
            return {
              withResponse: async () => ({
                data: {
                  id: 'mock-id',
                  model: req.model,
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: {
                        content: JSON.stringify({
                          summary: `Summary for ${modelName}.`,
                          keyChanges: [`Key change for ${modelName}.`],
                          qaChecks: [`Verify change for ${modelName}.`],
                          uncertainty: [],
                        }),
                      },
                    },
                  ],
                },
                request_id: 'req-1',
              }),
            };
          },
        },
      },
    } as any;
  };

  const client1 = createMockClient('custom-model-1');
  const client2 = createMockClient('custom-model-2');

  const report1 = await generateImpactReport({
    instruction: 'Instruction 1',
    evidence: { test: 1 },
    client: client1,
    options: { model: 'custom-model-1' },
  });

  const report2 = await generateImpactReport({
    instruction: 'Instruction 2',
    evidence: { test: 2 },
    client: client2,
    options: { model: 'custom-model-2' },
  });

  assert.equal(report1.summary, 'Summary for custom-model-1.');
  assert.equal(report2.summary, 'Summary for custom-model-2.');
  assert.deepEqual(requestedModels, ['custom-model-1', 'custom-model-2']);
});

test('context lifecycle: loads existing application context without invoking LLM or overwriting', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-ctx-test-'));
  try {
    const existingContext: ApplicationContext = {
      schemaVersion: '1.0',
      application: {
        name: 'ExistingApp',
        summary: 'Existing summary',
        purpose: 'Existing purpose',
      },
      domains: [{ id: 'core', name: 'Core', description: 'Core domain' }],
      terminology: [{ term: 'item', meaning: 'a thing' }],
      entityAnnotations: [
        {
          entityId: 'src/app.ts#calc',
          businessMeaning: 'calculates',
          domainIds: ['core'],
          confidence: 'high',
        },
      ],
      applicationFacts: ['fact 1'],
      unknowns: [],
    };

    const ctxFile = path.join(tmpDir, 'application-context.json');
    fs.writeFileSync(ctxFile, JSON.stringify(existingContext, null, 2), 'utf8');
    const mtimeBefore = fs.statSync(ctxFile).mtimeMs;

    const mockGraph: TechnicalGraph = {
      schemaVersion: '1.0',
      repository: { targetPath: '.', headSha: '123', analyzerVersion: '0.4.0' },
      capabilities: {
        language: 'typescript',
        entityKinds: ['function'],
        relationTypes: ['CALLS'],
        maxBlastDepth: 6,
      },
      analyzedFiles: ['src/app.ts'],
      entities: [
        {
          id: 'src/app.ts#calc',
          kind: 'function',
          name: 'calc',
          file: 'src/app.ts',
          startLine: 1,
          endLine: 3,
        },
      ],
      relations: [],
    };

    const loaded = await getOrCreateApplicationContext({
      contextDirectory: tmpDir,
      technicalGraph: mockGraph,
    });

    assert.equal(loaded.application.name, 'ExistingApp');
    const mtimeAfter = fs.statSync(ctxFile).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter, 'Existing context file must not be modified or rewritten');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('context lifecycle: throws when context is missing and no sourceFiles provided', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-ctx-missing-'));
  try {
    const mockGraph: TechnicalGraph = {
      schemaVersion: '1.0',
      repository: { targetPath: '.', headSha: '123', analyzerVersion: '0.4.0' },
      capabilities: {
        language: 'typescript',
        entityKinds: ['function'],
        relationTypes: ['CALLS'],
        maxBlastDepth: 6,
      },
      analyzedFiles: [],
      entities: [],
      relations: [],
    };

    await assert.rejects(
      () =>
        getOrCreateApplicationContext({
          contextDirectory: tmpDir,
          technicalGraph: mockGraph,
          sourceFiles: [],
        }),
      /application-context\.json not found/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
