import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { EngineProfile, FrontierReason } from '../src/contracts';
import { extractTechnicalGraph } from '../src/technical-graph';

const FIXTURES_ROOT = path.resolve(__dirname, '../../../fixtures');
const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', jsx: 'react-jsx', strict: true, experimentalDecorators: true, noEmit: true } });

function extract(files: Record<string, string>, engine: EngineProfile = 'extended') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-frontier-')));
  try {
    for (const [file, content] of Object.entries({ 'tsconfig.json': TSCONFIG, ...files })) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
    return extractTechnicalGraph({ projectRoot: dir, headSha: 'test', engine });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lineOf = (source: string, marker: string): number => {
  const index = source.split('\n').findIndex(line => line.includes(marker));
  assert.ok(index >= 0, `marker not found: ${marker}`);
  return index + 1;
};

const FRONTIER_SOURCE = `declare const anyFn: any;
declare const registry: Record<string, () => void>;
declare function Inject(token: unknown): (target: object, key: string | symbol | undefined, index: number) => void;
export function anyCall(): void { anyFn(); }
export function computedCall(name: string): void { registry[name](); }
export function dynRequire(name: string): unknown { return require(name); }
export function dynImport(name: string): unknown { return import(name); }
export function evalCall(code: string): unknown { return eval(code); }
export function funcCall(code: string): unknown { return Function(code); }
export function funcNew(code: string): unknown { return new Function(code); }
export function Panel({ Icon }: { Icon: () => null }) { return <Icon />; }
export class Service {
  constructor(@Inject('TOKEN') private readonly dep: unknown) {}
}
export function literals(): unknown {
  registry['literal']();
  registry[0]();
  require('./other');
  return import('./other');
}
`;

test('frontier: one example of each pattern is recorded against the enclosing entity', () => {
  const graph = extract({ 'src/m.tsx': FRONTIER_SOURCE });
  const items = graph.frontier.map(({ entityId, file, line, reason }) => [entityId, file, line, reason]);
  const at = (marker: string) => lineOf(FRONTIER_SOURCE, marker);
  assert.deepEqual(items, ([
    ['src/m.tsx#anyCall', 'src/m.tsx', at('export function anyCall'), 'any_typed_call'],
    ['src/m.tsx#computedCall', 'src/m.tsx', at('export function computedCall'), 'computed_member_call'],
    ['src/m.tsx#dynRequire', 'src/m.tsx', at('export function dynRequire'), 'dynamic_require'],
    ['src/m.tsx#dynImport', 'src/m.tsx', at('export function dynImport'), 'dynamic_import'],
    ['src/m.tsx#evalCall', 'src/m.tsx', at('export function evalCall'), 'eval'],
    ['src/m.tsx#funcCall', 'src/m.tsx', at('export function funcCall'), 'function_constructor'],
    ['src/m.tsx#funcNew', 'src/m.tsx', at('export function funcNew'), 'function_constructor'],
    ['src/m.tsx#Panel', 'src/m.tsx', at('export function Panel'), 'jsx_prop_component'],
    [items[8]?.[0], 'src/m.tsx', at('@Inject'), 'di_token'],
  ] as unknown[][]));
  assert.match(String(items[8][0]), /^src\/m\.tsx#Service/);
  const reasons = new Set<FrontierReason>(graph.frontier.map(item => item.reason));
  assert.equal(reasons.size, 8, 'every reason is exercised');
  assert.ok(graph.frontier.every(item => item.entityId !== 'src/m.tsx#literals'), 'literal arguments are not frontier');
  assert.deepEqual(graph.diagnostics.filter(item => item.code === 'FRONTIER_CAPPED'), []);
});

test('frontier: output is sorted and identical across runs', () => {
  const first = extract({ 'src/m.tsx': FRONTIER_SOURCE, 'src/a.ts': 'declare const f: any;\nexport function a(): void { f(); f(); }\n' });
  const second = extract({ 'src/m.tsx': FRONTIER_SOURCE, 'src/a.ts': 'declare const f: any;\nexport function a(): void { f(); f(); }\n' });
  assert.deepEqual(first.frontier, second.frontier);
  assert.deepEqual(first.relations, second.relations);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.frontier[0].file, 'src/a.ts', 'sorted by file first');
  const keys = first.frontier.map(item => `${item.file}\u0000${String(item.line).padStart(6, '0')}\u0000${item.reason}\u0000${item.entityId}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('frontier: items are capped at 20 per entity with one FRONTIER_CAPPED diagnostic', () => {
  const calls = Array.from({ length: 25 }, () => '  anyFn();').join('\n');
  const source = `declare const anyFn: any;\nexport function busy(): void {\n${calls}\n}\nexport function quiet(): void {\n  anyFn();\n}\n`;
  const graph = extract({ 'src/busy.ts': source });
  const busy = graph.frontier.filter(item => item.entityId === 'src/busy.ts#busy');
  assert.equal(busy.length, 20);
  assert.deepEqual(busy.map(item => item.line), Array.from({ length: 20 }, (_, index) => 3 + index), 'the first 20 in sorted order are kept');
  assert.equal(graph.frontier.filter(item => item.entityId === 'src/busy.ts#quiet').length, 1);
  assert.deepEqual(graph.diagnostics.filter(item => item.code === 'FRONTIER_CAPPED').map(item => [item.severity, item.entityId]), [['info', 'src/busy.ts#busy']]);
});

const CONFIDENCE_SOURCE = `export interface Runner { run(): void }
export class A implements Runner { run(): void {} }
export class B implements Runner { run(): void {} }
export function direct(a: A): void { a.run(); }
export function viaInterface(r: Runner): void { r.run(); }
export function handler(): void {}
export function register(cb: () => void): void { cb(); }
export function wire(): void { register(handler); }
export function keep(): () => void { return handler; }
export function overloaded(a: string): void;
export function overloaded(a: number): void;
export function overloaded(a: string | number): void {}
export function callsOverloaded(): void { overloaded('x'); }
`;

const edge = (graph: ReturnType<typeof extract>, from: string, type: string, to: string) =>
  graph.relations.find(relation => relation.from === `src/c.ts#${from}` && relation.type === type && relation.to === `src/c.ts#${to}`);

test('confidence: a direct call to a single declaration is proven (confidence absent)', () => {
  const direct = edge(extract({ 'src/c.ts': CONFIDENCE_SOURCE }), 'direct', 'CALLS', 'A.run');
  assert.ok(direct, 'direct call edge exists');
  assert.equal('confidence' in direct, false);
});

// An interface or abstract member has no entity of its own and the extractor does not fan out to implementations (D15),
// so a call through one yields no edge; it is a frontier site with reason interface_dispatch instead.
test('frontier: a call through an interface or abstract member is interface_dispatch and gives no edge', () => {
  const source = `interface Runner { run(): void; readonly hook: () => void }
abstract class Base { abstract go(): void; }
export function viaInterface(r: Runner): void { r.run(); }
export function viaProperty(r: Runner): void { r.hook(); }
export function viaAbstract(b: Base): void { b.go(); }
export function viaLiteral(o: { fn(): void }): void { o.fn(); }
export function plain(): void {}
export function direct(): void { plain(); }
export function builtin(text: string): string { return text.trim().toUpperCase(); }
`;
  const graph = extract({ 'src/i.ts': source });
  assert.deepEqual(graph.frontier.map(({ entityId, line, reason }) => [entityId, line, reason]), [
    ['src/i.ts#viaInterface', lineOf(source, 'export function viaInterface'), 'interface_dispatch'],
    ['src/i.ts#viaProperty', lineOf(source, 'export function viaProperty'), 'interface_dispatch'],
    ['src/i.ts#viaAbstract', lineOf(source, 'export function viaAbstract'), 'interface_dispatch'],
    ['src/i.ts#viaLiteral', lineOf(source, 'export function viaLiteral'), 'interface_dispatch'],
  ], 'built-in lib members (String.prototype.trim) are not interface_dispatch');
  assert.deepEqual(graph.relations.filter(relation => relation.from !== 'src/i.ts#direct').map(relation => relation.from), []);
  assert.equal(extract({ 'src/i.ts': source }, 'legacy').frontier.length, 0);
});

test('confidence: a symbol with several declarations is likely', () => {
  assert.equal(edge(extract({ 'src/c.ts': CONFIDENCE_SOURCE }), 'callsOverloaded', 'CALLS', 'overloaded')?.confidence, 'likely');
});

test('confidence: a callback REFERENCES edge is likely, a plain value reference is proven', () => {
  const graph = extract({ 'src/c.ts': CONFIDENCE_SOURCE });
  assert.equal(edge(graph, 'wire', 'REFERENCES', 'handler')?.confidence, 'likely');
  const returned = edge(graph, 'keep', 'REFERENCES', 'handler');
  assert.ok(returned);
  assert.equal('confidence' in returned, false);
});

test('confidence: dedup keeps the stronger edge regardless of order', () => {
  const both = `export function handler(): void {}
export function register(cb: () => void): void { cb(); }
export function mixed(): void { register(handler); const kept = handler; kept(); }
export function mixedReversed(): () => void { const kept = handler; register(handler); return kept; }
`;
  const graph = extract({ 'src/c.ts': both });
  assert.equal('confidence' in (edge(graph, 'mixed', 'REFERENCES', 'handler') ?? { confidence: 1 }), false, 'proven wins');
  assert.equal('confidence' in (edge(graph, 'mixedReversed', 'REFERENCES', 'handler') ?? { confidence: 1 }), false, 'proven wins in either order');
});

test('legacy engine: no confidence field and no frontier', () => {
  const legacySource = CONFIDENCE_SOURCE.split('\n').filter(line => !line.includes('overloaded')).join('\n');
  const graph = extract({ 'src/c.ts': legacySource, 'src/m.tsx': FRONTIER_SOURCE }, 'legacy');
  assert.ok(graph.relations.length > 0);
  assert.ok(graph.relations.every(relation => !('confidence' in relation)));
  assert.deepEqual(graph.frontier, []);
  assert.deepEqual(graph.diagnostics, []);
});

test('fixtures: modern-app and test-project extract deterministically with confidence and frontier', () => {
  for (const fixture of ['modern-app', 'test-project']) {
    const run = () => extractTechnicalGraph({ projectRoot: path.join(FIXTURES_ROOT, fixture), headSha: 'test', engine: 'extended' });
    const first = run();
    const second = run();
    assert.deepEqual(first.relations, second.relations);
    assert.deepEqual(first.frontier, second.frontier);
    assert.ok(first.relations.every(relation => relation.confidence === undefined || relation.confidence === 'likely'));
  }
});
