import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createAdapterContext } from '../../src/adapters/context';
import { classifyClientRequest } from '../../src/adapters/http-client';
import { mapFor } from './helper';

test('http-client: fetch and axios-style calls become client requests', () => {
  const { map } = mapFor({
    'package.json': JSON.stringify({ dependencies: { express: '4.0.0' } }),
    'src/api.ts': `
      declare const axios: any;
      export async function load() {
        await fetch('/api/orders', { method: 'post' });
        await axios.get('/api/orders/1');
      }
    `,
  });
  assert.deepEqual(map.requests.map(r => [r.method, r.target]), [['POST', '/api/orders'], ['GET', '/api/orders/1']]);
});

function classify(source: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-client-')));
  try {
    const file = path.join(dir, 'api.ts');
    fs.writeFileSync(file, source);
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, skipLibCheck: true });
    const ctx = createAdapterContext({
      program, checker: program.getTypeChecker(), symbolToEntity: new Map(), entities: [], relations: [], files: [file],
      toProjectPath: name => path.relative(dir, name).replace(/\\/g, '/'), projectRoot: dir, headSha: 'test',
    });
    const results: Array<ReturnType<typeof classifyClientRequest> | undefined> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) results.push(classifyClientRequest(ctx, node));
      ts.forEachChild(node, visit);
    };
    for (const sourceFile of ctx.sourceFiles) visit(sourceFile);
    return results.filter(Boolean).map(r => ({ method: r!.method, target: r!.target, form: r!.form, methodLiteral: r!.methodLiteral }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('http-client: classifyClientRequest reports how the URL and method were written', () => {
  const results = classify(`
    declare const axios: any; declare const api: any; declare const id: string; declare const url: string; declare const verb: string; declare const repo: any;
    const API = 'https://svc.example.com';
    const METHOD = 'delete';
    export function run() {
      fetch('/api/a');
      fetch('/api/b', { method: 'post' });
      fetch(\`/api/c/\${id}\`);
      fetch(API + '/b');
      fetch('/api/d', { method: METHOD });
      fetch(url);
      fetch('/api/e', { method: verb });
      axios.get('/api/f');
      api.get('/api/g');
      repo.get(id);
      api.get(url);
    }
  `);
  assert.deepEqual(results, [
    { method: 'GET', target: '/api/a', form: 'literal', methodLiteral: true },
    { method: 'POST', target: '/api/b', form: 'literal', methodLiteral: true },
    { method: 'GET', target: '/api/c/:param', form: 'template', methodLiteral: true },
    { method: 'GET', target: '/b', form: 'constant', methodLiteral: true },
    { method: 'DELETE', target: '/api/d', form: 'literal', methodLiteral: false },
    { method: 'GET', target: undefined, form: 'dynamic', methodLiteral: true },
    { method: undefined, target: '/api/e', form: 'literal', methodLiteral: false },
    { method: 'GET', target: '/api/f', form: 'literal', methodLiteral: true },
    { method: 'GET', target: '/api/g', form: 'wrapper', methodLiteral: true },
    { method: 'GET', target: undefined, form: 'dynamic', methodLiteral: true },
  ]);
});
