import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { criticalityFor, loadGraphentraConfig, matchesGlob } from '../src/config.js';

const load = (text?: string) => loadGraphentraConfig('/proj', () => text);

test('absent file yields no config and no diagnostics', () => {
  assert.deepEqual(load(undefined), { diagnostics: [] });
});

test('valid full file is parsed and sorted', () => {
  const text = [
    'version: 1',
    'criticality:',
    '  "b/*": low',
    '  "a/**": critical',
    'ignore: [zeta/**, alpha/**]',
    'tests: [e2e/**]',
    'surfaces:',
    '  - id: s2',
    '    kind: webhook',
    '    route: /hook',
    '    handler: h2',
    '  - id: api:GET /x',
    '    kind: api_endpoint',
    '    route: /x',
    '    method: GET',
    '    handler: h1',
    '',
  ].join('\n');
  const r = load(text);
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.config, {
    version: 1,
    criticality: [{ pattern: 'a/**', level: 'critical' }, { pattern: 'b/*', level: 'low' }],
    ignore: ['alpha/**', 'zeta/**'],
    tests: ['e2e/**'],
    surfaces: [
      { id: 'api:GET /x', kind: 'api_endpoint', route: '/x', method: 'GET', handler: 'h1' },
      { id: 's2', kind: 'webhook', route: '/hook', handler: 'h2' },
    ],
  });
});

function assertInvalid(text: string, location: string, reason: RegExp): void {
  const r = load(text);
  assert.equal(r.config, undefined);
  assert.equal(r.diagnostics.length, 1);
  const d = r.diagnostics[0];
  assert.equal(d.code, 'CONFIG_INVALID');
  assert.equal(d.severity, 'error');
  assert.equal(d.file, 'graphentra.yml');
  assert.ok(d.message.startsWith(`graphentra.yml:${location}`), d.message);
  assert.match(d.message, reason);
}

test('invalid cases report line and column', () => {
  assertInvalid('version: 1\nignore: [a\n', '3:1', /invalid YAML/);
  assertInvalid('version: 1\nignore: nope\n', '2:9', /list of strings/);
  assertInvalid('version: 1\ncriticality:\n  a: urgent\n', '3:6', /one of critical, high, normal, low/);
  assertInvalid('version: 1\nsurfaces:\n  - id: s\n    kind: bogus\n    route: /r\n    handler: h\n', '4:11', /surface kind/);
  assertInvalid('version: 1\nsurfaces:\n  - id: s\n    kind: webhook\n    route: /r\n', '3:5', /missing required "handler"/);
  assertInvalid('version: 2\n', '1:10', /"version" must be 1/);
  assertInvalid('ignore: []\n', '1:1', /"version" is required/);
  assertInvalid('- a\n', '1:1', /mapping/);
});

test('ignore and tests entries must be project-relative paths (excludePaths rules)', () => {
  assertInvalid('version: 1\nignore:\n  - ok/**\n  - ../outside\n', '4:5', /"ignore" entry "\.\.\/outside" must not contain a "\.\." segment/);
  assertInvalid('version: 1\nignore:\n  - /abs/**\n', '3:5', /must be relative/);
  assertInvalid('version: 1\nignore: ["a//b"]\n', '2:10', /must not contain "\/\/"/);
  assertInvalid('version: 1\ntests: [""]\n', '2:9', /"tests" entry "" must not be empty/);
  assertInvalid('version: 1\ntests: [C:/x]\n', '2:9', /must be relative/);
});

test('config surface ids must match kind, method and route, and be unique', () => {
  const s = (id: string, kind: string, route: string, method?: string) =>
    `  - id: "${id}"\n    kind: ${kind}\n    route: ${route}\n${method ? `    method: ${method}\n` : ''}    handler: h\n`;
  assertInvalid(`version: 1\nsurfaces:\n${s('api:GET /a', 'api_endpoint', '/a', 'POST')}`, '3:9', /expected "api:POST \/a"/);
  assertInvalid(`version: 1\nsurfaces:\n${s('ui:/b', 'ui_route', '/a')}`, '3:9', /expected "ui:\/a"/);
  assertInvalid(`version: 1\nsurfaces:\n${s('api:/a', 'api_endpoint', '/a')}`, '3:9', /expected "api:ANY \/a"/);
  assertInvalid(`version: 1\nsurfaces:\n${s('ui:/a', 'ui_route', '/a')}${s('ui:/a', 'ui_route', '/a')}`, '7:9', /duplicate surface id "ui:\/a"/);
  const ok = load(`version: 1\nsurfaces:\n${s('api:ANY /a', 'api_endpoint', '/a')}${s('hook-1', 'webhook', '/h')}`);
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(ok.config?.surfaces.length, 2);
});

test('unknown keys warn with line and config is still returned', () => {
  const r = load('version: 1\nextra: 1\nsurfaces:\n  - id: s\n    kind: webhook\n    route: /r\n    handler: h\n    color: red\n');
  assert.ok(r.config);
  assert.deepEqual(r.diagnostics.map(d => [d.code, d.severity]), [['CONFIG_UNKNOWN_KEY', 'warning'], ['CONFIG_UNKNOWN_KEY', 'warning']]);
  assert.match(r.diagnostics[0].message, /^graphentra\.yml:2:1: unknown key "extra"/);
  assert.match(r.diagnostics[1].message, /^graphentra\.yml:8:5: unknown key "color"/);
});

test('criticality precedence: exact, then longest glob, then lexical tie', () => {
  const r = load('version: 1\ncriticality:\n  "api:*": low\n  "api:GET /pay*": high\n  "api:GET /pay": critical\n  "api:POST /pay*": normal\n');
  const c = r.config!;
  assert.equal(criticalityFor(c, 'api:GET /pay'), 'critical');
  assert.equal(criticalityFor(c, 'api:GET /payments'), 'high');
  assert.equal(criticalityFor(c, 'api:POST /payments'), 'normal');
  assert.equal(criticalityFor(c, 'api:other'), 'low');
  assert.equal(criticalityFor(c, 'zzz'), undefined);
  const tie = load('version: 1\ncriticality:\n  "a*": low\n  "*b": high\n').config!;
  assert.equal(criticalityFor(tie, 'ab'), 'high');
});

test('glob matching', () => {
  assert.ok(matchesGlob('src/a/b.ts', 'src/**'));
  assert.ok(matchesGlob('src/a/b.ts', '**/b.ts'));
  assert.ok(matchesGlob('b.ts', '**/b.ts'));
  assert.ok(matchesGlob('src/b.ts', 'src/*.ts'));
  assert.ok(!matchesGlob('src/a/b.ts', 'src/*.ts'));
  assert.ok(matchesGlob('src/a.ts', 'src/?.ts'));
  assert.ok(!matchesGlob('src/ab.ts', 'src/?.ts'));
  assert.ok(!matchesGlob('src/a.ts', 'src/a_ts'));
  assert.ok(!matchesGlob('src/axts', 'src/a.ts'));
});

test('sha256 is of raw bytes and stable', () => {
  const text = 'version: 1\n';
  const a = load(text);
  assert.equal(a.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(load(text).sha256, a.sha256);
  assert.notEqual(load('version: 1\nignore: []\n').sha256, a.sha256);
});

test('config surface method is upper-cased and validated (HTTP methods plus ANY)', () => {
  const s = (id: string, method: string) => `  - id: "${id}"\n    kind: api_endpoint\n    route: /a\n    method: ${method}\n    handler: h\n`;
  const lower = load(`version: 1\nsurfaces:\n${s('api:GET /a', 'get')}`);
  assert.deepEqual(lower.diagnostics, []);
  assert.equal(lower.config?.surfaces[0]?.method, 'GET');
  assertInvalid(`version: 1\nsurfaces:\n${s('api:GET /a', 'GET')}${s('api:GET /a', 'get')}`, '8:9', /duplicate surface id "api:GET \/a"/);
  assertInvalid(`version: 1\nsurfaces:\n${s('api:FETCH /a', 'fetch')}`, '6:13', /surface method "fetch" must be one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, ANY/);
  assert.equal(load(`version: 1\nsurfaces:\n${s('api:ANY /a', 'any')}`).config?.surfaces[0]?.method, 'ANY');
});
