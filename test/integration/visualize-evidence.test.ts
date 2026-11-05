import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vm from 'node:vm';

const SCRIPT = path.resolve('tools/visualize-evidence.mjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-graph-'));

function entity(file: string, name: string, startLine: number, kind = 'function') {
  return { id: `${file}#${name}`, kind, name, file, startLine, endLine: startLine + 2, language: 'typescript' };
}

const core = entity('src/core.ts', 'core', 1);
const service = entity('src/service.ts', 'service', 1);
const route = entity('src/route.ts', 'route', 1);
const loopA = entity('src/loop-a.ts', 'loopA', 1);
const loopB = entity('src/loop-b.ts', 'loopB', 1);
const lonely = entity('src/lonely.ts', '</script><b>', 1);
const removed = entity('src/core.ts', 'removedHelper', 40);

const step = (from: { id: string }, to: { id: string }, type = 'CALLS') => ({ from: from.id, to: to.id, type });
const relations = [step(service, core), step(route, service, 'REFERENCES'), step(loopA, loopB), step(loopB, loopA), step(route, loopA)];

function evidenceFixture() {
  const trace = (target: typeof core, chain: (typeof core)[], types: string[]) => ({ target, depth: chain.length - 1, path: chain, pathCount: 1, stepTypes: types, confidence: 'proven' });
  return {
    artifactKind: 'graphentra-evidence',
    schemaVersion: '2.1',
    analyzerVersion: '0.5.0',
    target: { targetPath: 'fixture' },
    comparison: { mode: 'working-tree', requestedBase: 'HEAD', resolvedBaseSha: 'a'.repeat(40), comparedTo: 'the working tree' },
    outcome: 'completed',
    technicalGraph: {
      repository: { generatedAt: '2026-01-01T00:00:00.000Z' },
      capabilities: { maxBlastDepth: 6 },
      entities: [core, service, route, loopA, loopB, lonely],
      relations,
    },
    changedFiles: [{ file: 'src/core.ts' }, { file: 'README.md' }],
    changedEntities: [
      { entity: core, change: { changedLines: [2] }, changeKind: 'modified', changeClasses: ['body'] },
      { entity: removed, change: { changedLines: [] }, changeKind: 'deleted', changeClasses: ['deleted'] },
      { entity: service, change: { changedLines: [1] }, changeKind: 'modified', changeClasses: ['body'] },
    ],
    impacts: [
      {
        changedEntity: core,
        directDependents: [service],
        blastRadius: {
          totalAffectedEntities: 2,
          entities: [service, route],
          paths: [trace(service, [core, service], ['CALLS']), trace(route, [core, service, route], ['CALLS', 'REFERENCES'])],
          truncated: false,
        },
        terminalDependents: [route],
        confidence: 'proven',
      },
      {
        changedEntity: removed,
        directDependents: [loopA],
        blastRadius: { totalAffectedEntities: 1, entities: [loopA], paths: [trace(loopA, [removed, loopA], ['CALLS'])], truncated: false },
        terminalDependents: [loopA],
        confidence: 'proven',
      },
    ],
    diagnostics: [],
    limitations: ['Only TypeScript and JavaScript are analyzed.'],
  };
}

function run(evidence: unknown, name: string) {
  const input = path.join(directory, 'evidence.json');
  fs.writeFileSync(input, typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
  const out = path.join(directory, `${name}.html`);
  const result = spawnSync(process.execPath, [SCRIPT, input, '--no-open', '--out', out], { encoding: 'utf8' });
  return { result, out };
}

function render(evidence: unknown, name: string) {
  const { result, out } = run(evidence, name);
  assert.equal(result.status, 0, result.stderr);
  const page = fs.readFileSync(out, 'utf8');
  const json = /<script id="evidence-data" type="application\/json">(.*?)<\/script>/s.exec(page);
  assert.ok(json);
  const code = /<script>\n('use strict';.*)<\/script>/s.exec(page);
  assert.ok(code);
  return { page, json: json[1], code: code[1], model: JSON.parse(json[1]) };
}

test('evidence graph: same evidence gives identical bytes, whatever the input order', () => {
  const first = render(evidenceFixture(), 'first').page;
  assert.equal(render(evidenceFixture(), 'again').page, first);
  const shuffled = evidenceFixture();
  shuffled.technicalGraph.entities.reverse();
  shuffled.technicalGraph.relations = [...relations].reverse();
  assert.equal(render(shuffled, 'shuffled').page, first);
});

test('evidence graph: stats count each entity once and changed wins over affected', () => {
  const { stats, nodes, edges, types } = render(evidenceFixture(), 'stats').model;
  assert.equal(stats.changedEntities, 3);
  assert.equal(stats.affectedEntities, 2);
  assert.equal(stats.directAffected, 1);
  assert.equal(stats.transitiveAffected, 1);
  assert.equal(stats.changedAlsoReached, 1);
  assert.equal(stats.changedFiles, 2);
  assert.equal(stats.entities, 6);
  assert.equal(stats.relations, relations.length);

  const named = (name: string) => nodes.findIndex((node: { name: string }) => node.name === name);
  assert.equal(nodes[named('removedHelper')].ghost, true);
  assert.equal(nodes[named('route')].depth, 2);

  const impactEdge = (from: string, to: string) => edges.find((edge: number[]) => edge[0] === named(from) && edge[1] === named(to));
  assert.equal(impactEdge('service', 'core')[3], 1);
  assert.equal(impactEdge('route', 'service')[3], 1);
  assert.equal(impactEdge('route', 'loopA')[3], 0);
  // The deleted entity has no relation in the graph, so its step is inferred from the path.
  const inferred = impactEdge('loopA', 'removedHelper');
  assert.equal(inferred[5], 1);
  assert.equal(types[inferred[2]], 'CALLS');
});

test('evidence graph: cards never overlap and dependencies sit to the right', () => {
  const { views } = render(evidenceFixture(), 'layout').model;
  for (const view of [views.full, views.impact]) {
    const cards = view.cards;
    assert.ok(cards.length > 0);
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const [a, b] = [cards[i], cards[j]];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.file} overlaps ${b.file}`);
      }
    }
  }
  const at = (file: string) => views.full.cards.find((card: { file: string }) => card.file === file);
  assert.ok(at('src/route.ts').x < at('src/service.ts').x);
  assert.ok(at('src/service.ts').x < at('src/core.ts').x);
  assert.equal(at('src/loop-a.ts').x, at('src/loop-b.ts').x, 'files in a cycle share a layer');
});

test('evidence graph: entity text cannot break out of the embedded data', () => {
  const { page, model } = render(evidenceFixture(), 'escape');
  assert.ok(!page.includes('</script><b>'));
  assert.ok(model.nodes.some((node: { name: string }) => node.name === '</script><b>'));
});

test('evidence graph: bad input fails with a readable message and no page', () => {
  const notJson = run('{nope', 'bad-json');
  assert.equal(notJson.result.status, 1);
  assert.match(notJson.result.stderr, /not valid JSON/);
  assert.ok(!fs.existsSync(notJson.out));

  const wrongKind = run({ artifactKind: 'other' }, 'bad-kind');
  assert.equal(wrongKind.result.status, 1);
  assert.match(wrongKind.result.stderr, /not a Graphentra evidence file/);

  const missing = spawnSync(process.execPath, [SCRIPT, path.join(directory, 'absent.json'), '--no-open'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot read/);

  const noArgument = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(noArgument.status, 2);
  assert.match(noArgument.stderr, /Usage:/);
});

type Listener = (event: Record<string, unknown>) => void;

// A stand-in for the browser, enough to run the viewer's real code and record what it draws.
function bootViewer(code: string, json: string) {
  const drawn: string[] = [];
  const frames: FrameRequestCallback[] = [];
  const makeElement = (): any => {
    const listeners: Record<string, Listener> = {};
    const element: any = {
      style: {},
      hidden: false,
      children: [],
      textContent: '',
      offsetWidth: 120,
      offsetHeight: 40,
      classList: { add() {}, remove() {}, toggle() {} },
      append: (...items: unknown[]) => element.children.push(...items),
      replaceChildren: (...items: unknown[]) => { element.children = items; },
      setAttribute() {},
      setPointerCapture() {},
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
      addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; },
      fire: (type: string, event: Record<string, unknown> = {}) => listeners[type]({ preventDefault() {}, ...event }),
    };
    return element;
  };
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : (...args: unknown[]) => {
      if (key === 'fillText') drawn.push(String(args[0]));
    }),
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  const elements = new Map<string, any>();
  const byId = (id: string) => {
    if (!elements.has(id)) {
      const element = makeElement();
      if (id === 'evidence-data') element.textContent = json;
      if (id === 'graph') element.getContext = () => context;
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const windowListeners: Record<string, Listener> = {};
  const sandbox: Record<string, unknown> = {
    document: { getElementById: byId, createElement: makeElement, createElementNS: makeElement, title: '' },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
    ResizeObserver: class { observe() {} },
    HTMLInputElement: class {},
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    devicePixelRatio: 2,
    addEventListener: (type: string, listener: Listener) => { windowListeners[type] = listener; },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);
  const flush = () => { while (frames.length) frames.shift()!(0); };
  flush();
  return { byId, flush, drawn, windowListeners };
}

test('evidence graph: viewer runs through zoom, views, selection and search without errors', () => {
  const { code, json } = render(evidenceFixture(), 'viewer');
  const { byId, flush, drawn, windowListeners } = bootViewer(code, json);
  const canvas = byId('graph');
  assert.equal(byId('statChanged').textContent, '3');
  assert.equal(byId('statAffected').textContent, '2');
  assert.ok(drawn.includes('route'), 'entity labels are drawn at the fitted zoom');

  const zoomLabel = () => Number.parseInt(byId('zoomLevel').textContent, 10);
  const fitted = zoomLabel();
  byId('zoomIn').fire('click');
  assert.ok(zoomLabel() > fitted);
  for (let i = 0; i < 40; i += 1) canvas.fire('wheel', { deltaY: 300, deltaMode: 0, clientX: 500, clientY: 300 });
  flush();
  assert.equal(zoomLabel(), 2, 'zoom out stops at the minimum');
  for (let i = 0; i < 80; i += 1) canvas.fire('wheel', { deltaY: -300, deltaMode: 0, clientX: 500, clientY: 300 });
  flush();
  assert.equal(zoomLabel(), 400, 'zoom in stops at the maximum');
  byId('fitAll').fire('click');
  flush();

  byId('viewImpact').fire('click');
  flush();
  byId('fitImpact').fire('click');
  flush();
  for (const [x, y] of [[100, 100], [500, 350], [800, 500]]) {
    canvas.fire('pointermove', { clientX: x, clientY: y });
    canvas.fire('pointerdown', { clientX: x, clientY: y, pointerId: 1 });
    canvas.fire('pointerup', { clientX: x, clientY: y });
    flush();
  }
  canvas.fire('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
  canvas.fire('pointermove', { clientX: 90, clientY: 90 });
  canvas.fire('pointerup', { clientX: 90, clientY: 90 });
  flush();

  const search = byId('search');
  search.value = 'route';
  search.fire('input');
  const results = byId('results');
  assert.equal(results.children.length, 1);
  // Picking a result selects it and opens the details panel with its route to the change.
  results.children[0].children[0].fire('click');
  flush();
  assert.equal(byId('details').hidden, false);
  const details = byId('details').children.map((child: { textContent: string }) => child.textContent);
  assert.ok(details.includes('Why it is affected'));
  windowListeners.keydown({ key: 'Escape', target: {} });
  flush();
  assert.equal(byId('details').hidden, true);
  byId('viewFull').fire('click');
  flush();
});

test('evidence graph: a file with no changes renders with empty impact', () => {
  const evidence = evidenceFixture();
  Object.assign(evidence, { outcome: 'no_changes', changedFiles: [], changedEntities: [], impacts: [] });
  const { code, json, model } = render(evidence, 'quiet');
  assert.equal(model.stats.changedEntities, 0);
  assert.equal(model.views.impact.cards.length, 0);
  const { byId } = bootViewer(code, json);
  assert.equal(byId('viewImpact').disabled, true);
  assert.equal(byId('banner').children.length, 1);
});
