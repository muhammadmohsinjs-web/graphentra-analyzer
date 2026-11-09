import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { createAdapterContext } from '../src/adapters/context';
import type { Entity, SurfaceNode } from '../src/contracts';
import { collectClientCalls, linkEndpoints, type ClientCall } from '../src/endpoint-links';

function api(method: string, route: string): SurfaceNode {
  return { id: `api:${method} ${route}`, kind: 'api_endpoint', route, method, file: 'server.ts', line: 1, handlerEntityIds: [], adapter: { id: 'express', version: '1' }, confidence: 'proven', source: 'detected' };
}
const call = (patch: Partial<ClientCall>): ClientCall =>
  ({ entityId: 'fn:a', file: 'a.ts', line: 3, method: 'GET', target: '/api/users', form: 'literal', methodLiteral: true, ...patch });
const SURFACES = [api('GET', '/api/users'), api('POST', '/api/users'), api('GET', '/api/users/:id')];

test('endpoint-links: literal URL and method matching one endpoint is proven', () => {
  const { edges, frontier } = linkEndpoints([call({})], SURFACES);
  assert.deepEqual(edges, [{ from: 'fn:a', to: 'api:GET /api/users', type: 'CALLS_ENDPOINT', confidence: 'proven' }]);
  assert.deepEqual(frontier, []);
});

test('endpoint-links: template literal and param match are likely', () => {
  const template = linkEndpoints([call({ target: '/api/users/:param', form: 'template' })], SURFACES);
  assert.deepEqual(template.edges.map(e => [e.to, e.confidence]), [['api:GET /api/users/:id', 'likely']]);
  const literalParam = linkEndpoints([call({ target: '/api/users/7' })], SURFACES);
  assert.deepEqual(literalParam.edges.map(e => [e.to, e.confidence]), [['api:GET /api/users/:id', 'likely']]);
});

test('endpoint-links: wrapper and base-URL constant are likely', () => {
  for (const form of ['wrapper', 'constant'] as const) {
    const { edges } = linkEndpoints([call({ form })], SURFACES);
    assert.deepEqual(edges.map(e => e.confidence), ['likely'], form);
  }
});

test('endpoint-links: a non-literal method is likely', () => {
  const { edges } = linkEndpoints([call({ methodLiteral: false })], SURFACES);
  assert.deepEqual(edges.map(e => e.confidence), ['likely']);
});

test('endpoint-links: more than one matching endpoint gives a likely edge to each', () => {
  const { edges } = linkEndpoints([call({ method: undefined, methodLiteral: false })], SURFACES);
  assert.deepEqual(edges.map(e => [e.to, e.confidence]), [['api:GET /api/users', 'likely'], ['api:POST /api/users', 'likely']]);
  const any = linkEndpoints([call({})], [api('GET', '/api/users'), api('GET', '/api/users')].map((s, i) => ({ ...s, id: `${s.id}#${i}` })));
  assert.deepEqual(any.edges.map(e => e.confidence), ['likely', 'likely']);
});

test('endpoint-links: a method mismatch or an external URL yields no edge', () => {
  assert.deepEqual(linkEndpoints([call({ method: 'DELETE' }), call({ target: '/other' })], SURFACES), { edges: [], frontier: [] });
});

test('endpoint-links: an unresolvable URL becomes a dynamic_endpoint_url frontier item', () => {
  const { edges, frontier } = linkEndpoints([call({ target: undefined, form: 'dynamic', line: 9 }), call({ target: undefined, form: 'dynamic', line: 9 })], SURFACES);
  assert.deepEqual(edges, []);
  assert.deepEqual(frontier, [{ entityId: 'fn:a', file: 'a.ts', line: 9, reason: 'dynamic_endpoint_url' }]);
});

test('endpoint-links: output is sorted and independent of input order', () => {
  const calls = [call({ entityId: 'fn:b', method: 'POST' }), call({ entityId: 'fn:a' }), call({ entityId: 'fn:a', method: 'POST' }),
    call({ entityId: 'fn:z', target: undefined, form: 'dynamic', file: 'z.ts' }), call({ entityId: 'fn:c', target: undefined, form: 'dynamic', file: 'c.ts' })];
  const forward = linkEndpoints(calls, SURFACES);
  const backward = linkEndpoints([...calls].reverse(), [...SURFACES].reverse());
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.edges.map(e => `${e.from}|${e.to}`), ['fn:a|api:GET /api/users', 'fn:a|api:POST /api/users', 'fn:b|api:POST /api/users']);
  assert.deepEqual(forward.frontier.map(f => f.entityId), ['fn:c', 'fn:z']);
});

test('endpoint-links: a stronger duplicate edge wins', () => {
  const { edges } = linkEndpoints([call({ form: 'wrapper' }), call({})], SURFACES);
  assert.deepEqual(edges.map(e => e.confidence), ['proven']);
});

test('endpoint-links: collectClientCalls attributes calls to the enclosing entity', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-links-')));
  try {
    const file = path.join(dir, 'ui.ts');
    fs.writeFileSync(file, `declare const id: string;\nexport function load() {\n  return fetch('/api/users');\n}\nexport function show() {\n  return fetch(\`/api/users/\${id}\`);\n}\n`);
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, skipLibCheck: true });
    const checker = program.getTypeChecker();
    const symbolToEntity = new Map<ts.Symbol, Entity>();
    for (const statement of program.getSourceFile(file)!.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) symbolToEntity.set(checker.getSymbolAtLocation(statement.name)!, { id: `fn:${statement.name.text}` } as Entity);
    }
    const ctx = createAdapterContext({
      program, checker, symbolToEntity, entities: [...symbolToEntity.values()], relations: [], files: [file],
      toProjectPath: name => path.relative(dir, name).replace(/\\/g, '/'), projectRoot: dir, headSha: 'test',
    });
    const calls = collectClientCalls(ctx);
    assert.deepEqual(calls.map(c => [c.entityId, c.file, c.line, c.method, c.target, c.form]), [
      ['fn:load', 'ui.ts', 3, 'GET', '/api/users', 'literal'],
      ['fn:show', 'ui.ts', 6, 'GET', '/api/users/:param', 'template'],
    ]);
    assert.deepEqual(linkEndpoints(calls, SURFACES).edges.map(e => [e.from, e.to, e.confidence]), [
      ['fn:load', 'api:GET /api/users', 'proven'], ['fn:show', 'api:GET /api/users/:id', 'likely'],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
