import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository, buildGraphIndex, type Entity, type EntityImpact, type Relation } from '@graphentra/analyzer';
import { clusterChanges, generateQAReport, mergeGroupReports, placeTriggers, rankTriggers, relatedCodeFor, TRIGGER_AREA, type ImpactReport } from '../src/index';

const entity = (id: string, startLine = 1): Entity => {
  const [file, name] = id.split('#') as [string, string];
  return { id, kind: 'function', name, file, startLine, endLine: startLine + 2 };
};
const impact = (e: Entity, affected = 1): EntityImpact => ({
  changedEntity: e, change: { file: e.file, changedLines: [e.startLine], addedCode: ['new'], removedCode: ['old'], diff: '-old\n+new' },
  directDependents: [], blastRadius: { totalAffectedEntities: affected, entities: [], paths: [] }, terminalDependents: [],
});
const calls = (from: string, to: string): Relation => ({ from, to, type: 'CALLS' });

/** `modules` files of `per` functions each; every module has one consumer that calls all of its functions. */
function modules(count: number, per: number) {
  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const changed: Entity[] = [];
  for (let m = 0; m < count; m += 1) {
    const consumer = entity(`app/m${m}/use.ts#use`);
    entities.push(consumer);
    for (let f = 0; f < per; f += 1) {
      const fn = entity(`lib/m${m}/f.ts#f${f}`, f * 5 + 1);
      entities.push(fn); changed.push(fn); relations.push(calls(consumer.id, fn.id));
    }
  }
  return { entities, relations, changed };
}

test('changes that share a consumer land in one group, and no group exceeds the limit', () => {
  const { entities, relations, changed } = modules(3, 8);
  const groups = clusterChanges(changed.map(e => impact(e)), buildGraphIndex({ entities, relations }));
  assert.equal(groups.length, 3);
  for (const group of groups) {
    assert.equal(group.impacts.length, 8);
    assert.equal(new Set(group.impacts.map(i => i.changedEntity.file)).size, 1, 'a module is not split');
    assert.equal(group.sharedConsumers.length, 1);
  }
  assert.equal(groups.flatMap(g => g.impacts).length, 24, 'every change is in exactly one group');
  assert.equal(new Set(groups.flatMap(g => g.impacts.map(i => i.changedEntity.id))).size, 24);
});

test('grouping is deterministic and does not depend on input order', () => {
  const { entities, relations, changed } = modules(4, 7);
  const index = buildGraphIndex({ entities, relations });
  const ids = (list: Entity[]) => clusterChanges(list.map(e => impact(e)), index).map(g => g.impacts.map(i => i.changedEntity.id));
  assert.deepEqual(ids([...changed].reverse()), ids(changed));
  assert.deepEqual(ids(changed), ids(changed));
});

test('related leftovers are packed, never one group per function, and maxGroups bounds the group count', () => {
  const entities = Array.from({ length: 40 }, (_, i) => entity(`lib/dir${i % 5}/file${i}.ts#fn${i}`));
  const index = buildGraphIndex({ entities, relations: [] });
  const impacts = entities.map(e => impact(e));
  const packed = clusterChanges(impacts, index);
  assert.ok(packed.length <= 8 && packed.every(g => g.impacts.length <= 10), `got ${packed.map(g => g.impacts.length)}`);
  assert.equal(packed.flatMap(g => g.impacts).length, 40);
  // Same directory shares a group when there is room.
  const byDir = new Map<string, Set<number>>();
  packed.forEach((g, gi) => g.impacts.forEach(i => { const d = i.changedEntity.file.split('/')[1]!; (byDir.get(d) ?? byDir.set(d, new Set()).get(d)!).add(gi); }));
  for (const groupsOfDir of byDir.values()) assert.ok(groupsOfDir.size <= 2, 'a directory is not scattered');
  const tight = clusterChanges(impacts, index, { maxGroups: 2 });
  assert.equal(tight.length, 2);
  assert.ok(tight.every(g => g.impacts.length <= 20));
});

test('a consumer of everything does not glue unrelated changes together', () => {
  const { entities, relations, changed } = modules(2, 10);
  const hub = entity('app/hub.ts#hub');
  const index = buildGraphIndex({ entities: [...entities, hub], relations: [...relations, ...changed.map(e => calls(hub.id, e.id))] });
  const groups = clusterChanges(changed.map(e => impact(e)), index);
  assert.deepEqual(groups.map(g => g.impacts.length), [10, 10]);
  for (const group of groups) assert.equal(new Set(group.impacts.map(i => i.changedEntity.file)).size, 1);
});

test('groups are reviewed largest blast radius first', () => {
  const { entities, relations, changed } = modules(2, 5);
  const index = buildGraphIndex({ entities, relations });
  const groups = clusterChanges(changed.map(e => impact(e, e.file.includes('m1') ? 50 : 1)), index);
  assert.ok(groups[0]!.impacts[0]!.changedEntity.file.includes('m1'));
  assert.deepEqual(groups.map(g => g.index), [1, 2]);
});

const area = (name: string, checks: string[], surfaceIds: string[] = []) => ({ area: name, surfaceIds, howToReach: 'Open the page.', access: 'Anyone.', setup: 'None.', checks });
const report = (summary: string, areas: ReturnType<typeof area>[], keyChanges = ['Something changed.'], uncertainty: string[] = []): ImpactReport =>
  ({ summary, keyChanges, qaChecks: areas.flatMap(a => a.checks).slice(0, 5), uncertainty, testAreas: areas });

test('the merge keeps every check, key change and uncertainty, with no cap', () => {
  const groups = Array.from({ length: 4 }, (_, g) => report(`Group ${g}.`,
    Array.from({ length: 5 }, (_, a) => area(`Area ${g}-${a}`, [`Verify check ${g}-${a}-1.`, `Verify check ${g}-${a}-2.`])),
    [`Key change ${g}.`], [`Unsure ${g}.`]));
  const merged = mergeGroupReports(groups, 'Overall.');
  assert.equal(merged.testAreas!.length, 20, 'five areas per group, none dropped');
  assert.equal(merged.qaChecks.length, 40);
  assert.equal(merged.keyChanges.length, 4);
  assert.equal(merged.uncertainty.length, 4);
  assert.equal(merged.summary, 'Overall.');
});

test('the merge removes exact duplicates, joins an area by name and surfaces, and keeps four checks per entry', () => {
  const a = report('A.', [area('Checkout', ['Verify one.', 'Verify two.', 'Verify three.'], ['ui:/checkout'])], ['Same.'], ['Same doubt.']);
  const b = report('B.', [area('checkout', ['verify  ONE.', 'Verify four.', 'Verify five.'], ['ui:/checkout']), area('Checkout', ['Verify six.'], [])], ['same.'], ['Same doubt.']);
  const merged = mergeGroupReports([a, b], 'Both.');
  assert.deepEqual(merged.keyChanges, ['Same.']);
  assert.deepEqual(merged.uncertainty, ['Same doubt.']);
  const checkout = merged.testAreas!.filter(x => x.surfaceIds.length);
  assert.deepEqual(checkout.map(x => x.checks), [['Verify one.', 'Verify two.', 'Verify three.', 'Verify four.'], ['Verify five.']]);
  assert.ok(merged.testAreas!.every(x => x.checks.length <= 4));
  assert.equal(merged.testAreas!.find(x => !x.surfaceIds.length)!.checks[0], 'Verify six.', 'same name with other surfaces stays separate');
  assert.equal(merged.qaChecks.length, 6);
});

test('related code carries each changed function in full, then callers and callees, by ID', () => {
  const files: Record<string, string> = {
    'lib/a.ts': ['export function changed() {', '  return helper() + 1;', '}', ''].join('\n'),
    'lib/h.ts': 'export function helper() {\n  return 2;\n}\n',
    'app/c.ts': 'export function caller() {\n  return changed();\n}\n',
    'app/c.test.ts': 'export function testCaller() {\n  return changed();\n}\n',
  };
  const e = { changed: { ...entity('lib/a.ts#changed', 1), endLine: 3 }, helper: { ...entity('lib/h.ts#helper', 1), endLine: 3 },
    caller: { ...entity('app/c.ts#caller', 1), endLine: 3 }, testCaller: { ...entity('app/c.test.ts#testCaller', 1), endLine: 3 } };
  const index = buildGraphIndex({ entities: Object.values(e), relations: [calls(e.caller.id, e.changed.id), calls(e.testCaller.id, e.changed.id), calls(e.changed.id, e.helper.id)] });
  const group = clusterChanges([impact(e.changed)], index)[0]!;
  const related = relatedCodeFor(group, index, file => files[file]);
  assert.deepEqual(related.code.map(c => `${c.role}:${c.entity}`), ['changed:lib/a.ts#changed', 'caller:app/c.ts#caller', 'callee:lib/h.ts#helper']);
  assert.ok(related.code[0]!.code.startsWith('1: export function changed()'));
  assert.equal(relatedCodeFor(group, index, file => files[file], { maxRelatedBytes: 10 }).truncated, true);
  assert.deepEqual(relatedCodeFor(group, index, () => undefined).code, [], 'unreadable source adds nothing and does not throw');
  // A changed function whose file no longer exists at the analyzed revision (removed, renamed away) is read from the base revision.
  const gone = { ...entity('old/gone.ts#removed', 1), endLine: 3 };
  const goneIndex = buildGraphIndex({ entities: [gone], relations: [] });
  const goneGroup = clusterChanges([impact(gone)], goneIndex)[0]!;
  assert.deepEqual(relatedCodeFor(goneGroup, goneIndex, () => undefined).code, [], 'without a base reader a removed function adds nothing');
  const fromBase = relatedCodeFor(goneGroup, goneIndex, () => undefined, { readBase: () => 'export function removed() {\n  return 1;\n}\n' }).code;
  assert.deepEqual(fromBase.map(c => `${c.role}:${c.revision}`), ['changed:base']);
  assert.ok(fromBase[0]!.code.startsWith('1: export function removed()'));
});

// ---- generateQAReport end to end, with a fake provider ----

const quiet = (t: { mock: { method: (object: object, name: string, fn: () => void) => void } }) => t.mock.method(console, 'info', () => {});
const context = { schemaVersion: '1.0', application: { name: 'Test', summary: 'Test', purpose: 'Test' }, domains: [], terminology: [], entityAnnotations: [], applicationFacts: [], unknowns: [] };

function repoWith(files: number, perFile: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-'));
  const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(dir, '.no-hooks')}`, ...args], { cwd: dir, stdio: 'pipe' });
  const source = (file: number, value: number) => Array.from({ length: perFile }, (_, f) => `export function fn${file}x${f}() { return ${value}; }`).join('\n');
  git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  for (let file = 0; file < files; file += 1) fs.writeFileSync(path.join(dir, `m${file}.ts`), source(file, 1));
  git(['add', '.']); git(['commit', '-m', 'initial']);
  for (let file = 0; file < files; file += 1) fs.writeFileSync(path.join(dir, `m${file}.ts`), source(file, 2));
  return { dir, evidence: analyzeRepository({ target: dir, comparison: { mode: 'working-tree' } }).evidence, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function fakeProvider(options: { failWhen?: (user: any) => boolean; failOnce?: (user: any) => boolean; failTriggers?: boolean } = {}) {
  const failedOnce = new Set<string>();
  const seen: Array<{ schema: string; user: any; system: string }> = [];
  let reports = 0;
  const client: any = { chat: { completions: { create: (body: any) => {
    const schema = body.response_format.json_schema.name as string;
    const text: string = body.messages[1].content;
    let user: any = {};
    try { user = JSON.parse(text.slice(text.indexOf('{'))); } catch { /* the summary request carries a JSON array */ }
    seen.push({ schema, user, system: body.messages[0].content });
    if (schema === 'qa_change_impact_report' && options.failWhen?.(user)) throw new Error('provider refused');
    if (schema === 'qa_change_impact_report' && options.failOnce?.(user)) {
      const key = String(user.changes?.[0]?.changedEntity);
      if (!failedOnce.has(key)) { failedOnce.add(key); throw new Error('402 credit limit'); }
    }
    reports += schema === 'qa_change_impact_report' ? 1 : 0;
    if (schema === 'qa_cluster_triggers' && options.failTriggers) throw new Error('provider refused triggers');
    const trigger = (id: string, check: string) => ({ changedFunction: id, behaviourChange: 'Returns a new value.', input: 'An empty price.', before: 'Showed one.', after: 'Shows two.', check });
    const content = JSON.stringify(schema === 'qa_cluster_triggers'
      ? { triggers: [
        ...user.changes.map((c: any, i: number) => trigger(c.changedEntity, `Confirm on the pricing page with an empty price in row ${c.changedEntity.replace(/\D+/g, ' ').trim()} item ${i}; it showed one before, so two must be intended.`)),
        trigger('not-a-changed-function', 'Confirm on the pricing page that nothing else changed.'),
        trigger(user.changes[0].changedEntity, 'Confirm the priceValue is shown.'),
      ] }
      : schema === 'qa_cluster_summary'
      ? { summary: 'Several parts of the release changed and need testing.' }
      : { summary: `Review number ${reports} found a change.`, keyChanges: [`Review number ${reports} found a changed value.`], testAreas: [area('Pricing page', [`Verify review number ${reports} shows the new value.`])], uncertainty: [] });
    const completion = { id: `fake-${seen.length}`, model: body.model, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const promise: any = Promise.resolve(completion);
    promise.withResponse = async () => ({ data: completion, request_id: 'fake' });
    return promise;
  } } } };
  return { client, seen };
}

test('more than 15 changed functions are reviewed per group and merged without loss', async t => {
  quiet(t);
  const repo = repoWith(3, 6);
  try {
    assert.equal(repo.evidence.impacts.length, 18);
    const provider = fakeProvider();
    const read = (file: string) => { try { return fs.readFileSync(path.join(repo.dir, file), 'utf8'); } catch { return undefined; } };
    const result = await generateQAReport(repo.evidence, context, { client: provider.client, model: 'offline' }, { cluster: { read } });
    const reviews = provider.seen.filter(call => call.schema === 'qa_change_impact_report');
    assert.equal(reviews.length, 3, 'one review per module');
    assert.equal(provider.seen.filter(call => call.schema === 'qa_cluster_summary').length, 1);
    const reviewed = reviews.flatMap(call => call.user.changes.map((c: any) => c.changedEntity));
    assert.equal(new Set(reviewed).size, 18, 'every changed function is reviewed once');
    assert.ok(reviews.every(call => call.user.changes.length === 6));
    assert.ok(reviews.every(call => call.system.includes('group ') && call.system.includes('of 3 of one large change')));
    for (const call of reviews) assert.ok(call.user.relatedCode.filter((c: any) => c.role === 'changed').length === 6, 'full code of each changed function');
    assert.equal(provider.seen.filter(call => call.schema === 'qa_cluster_triggers').length, 0, 'triggers are opt-in');
    assert.equal(result.qaReport.qaChecks.length, 3, 'the three distinct checks all survive');
    assert.equal(result.qaReport.testAreas!.length, 1, 'same area name and surfaces are joined');
    assert.equal(result.qaReport.testAreas![0]!.checks.length, 3);
    assert.equal(result.qaReport.summary, 'Several parts of the release changed and need testing.');
    assert.equal(result.cluster!.groups.length, 3);
    assert.equal(result.cluster!.checksIn, result.cluster!.checksOut);
    assert.ok(result.markdownReport.includes('Where and what to test'));
  } finally { repo.cleanup(); }
});

test('a group whose review fails is listed as not covered and the rest of the report stays', async t => {
  quiet(t);
  const repo = repoWith(3, 6);
  try {
    const provider = fakeProvider({ failWhen: user => user.changes.some((c: any) => c.changedEntity.startsWith('m1.ts#')) });
    const result = await generateQAReport(repo.evidence, context, { client: provider.client, model: 'offline' }, { cluster: { retryDelayMs: 0 } });
    assert.equal(result.qaReport.qaChecks.length, 2);
    assert.equal(result.qaReport.notCovered!.length, 6);
    assert.ok(result.qaReport.notCovered!.every(item => item.file === 'm1.ts' && item.reason === 'error'));
    assert.equal(result.cluster!.groups.filter(g => !g.ok).length, 1);
    assert.equal(result.cluster!.groups.find(g => !g.ok)!.attempts, 3, 'a failing group is tried 1 + 2 retries times');
    assert.ok(result.markdownReport.includes('m1.ts'), 'the gap is visible to the reader');
    await assert.rejects(generateQAReport(repo.evidence, context, { client: fakeProvider({ failWhen: () => true }).client, model: 'offline' }, { cluster: { retryDelayMs: 0 } }), /Every group review failed/);
  } finally { repo.cleanup(); }
});

test('a group review that fails once is retried and its findings are kept', async t => {
  quiet(t);
  const repo = repoWith(3, 6);
  try {
    const provider = fakeProvider({ failOnce: () => true });
    const result = await generateQAReport(repo.evidence, context, { client: provider.client, model: 'offline' }, { cluster: { retryDelayMs: 0 } });
    assert.equal(result.qaReport.notCovered, undefined, 'nothing is dropped after a successful retry');
    assert.equal(result.qaReport.qaChecks.length, 3);
    assert.ok(result.cluster!.groups.every(g => g.ok && g.attempts === 2));
    const none = await generateQAReport(repo.evidence, context, { client: fakeProvider({ failOnce: () => true }).client, model: 'offline' }, { cluster: { retryDelayMs: 0, groupRetries: 0 } }).catch(error => error as Error);
    assert.match((none as Error).message, /Every group review failed/, 'groupRetries 0 turns the retry off');
  } finally { repo.cleanup(); }
});

test('15 changed functions or fewer take the single-call path, and so does a run without the cluster option', async t => {
  quiet(t);
  const small = repoWith(3, 5);
  try {
    assert.equal(small.evidence.impacts.length, 15);
    const provider = fakeProvider();
    const result = await generateQAReport(small.evidence, context, { client: provider.client, model: 'offline' }, { cluster: {} });
    assert.equal(provider.seen.length, 1);
    assert.equal(result.cluster, undefined);
  } finally { small.cleanup(); }
  const large = repoWith(3, 6);
  try {
    const provider = fakeProvider();
    const byDefault = await generateQAReport(large.evidence, context, { client: provider.client, model: 'offline' });
    assert.ok(byDefault.cluster && byDefault.cluster.groups.length > 1, 'cluster is on by default above 15 changed functions');
    assert.ok(provider.seen.length > 1);
    const off = fakeProvider();
    const single = await generateQAReport(large.evidence, context, { client: off.client, model: 'offline' }, { cluster: false });
    assert.equal(off.seen.length, 1, 'cluster: false writes one report for everything');
    assert.equal(single.cluster, undefined);
    const lowered = fakeProvider();
    await generateQAReport(large.evidence, context, { client: lowered.client, model: 'offline' }, { cluster: { threshold: 20 } });
    assert.equal(lowered.seen.length, 1, 'the threshold is configurable');
  } finally { large.cleanup(); }
});

test('triggers add one check per changed function to each group and drop invalid ones', async t => {
  quiet(t);
  const repo = repoWith(3, 6);
  try {
    const provider = fakeProvider();
    const read = (file: string) => { try { return fs.readFileSync(path.join(repo.dir, file), 'utf8'); } catch { return undefined; } };
    const result = await generateQAReport(repo.evidence, context, { client: provider.client, model: 'offline' }, { cluster: { read, triggers: true } });
    const calls = provider.seen.filter(call => call.schema === 'qa_cluster_triggers');
    assert.equal(calls.length, 6, 'one trigger call per group plus one correction request each (invalid items)');
    assert.ok(calls.every(call => call.user.relatedCode && call.user.changes.every((c: any) => 'change' in c)), 'the diff and the related code are sent');
    assert.ok(result.cluster!.groups.every(g => g.ok && g.triggers === 6 && !g.triggerError), 'the unknown function and the code-named check are dropped');
    const area = result.qaReport.testAreas!.filter(a => a.area === TRIGGER_AREA);
    assert.equal(area.flatMap(a => a.checks).length, 15, 'the main list is capped at 15 trigger checks');
    assert.ok(area.every(a => a.checks.length <= 4), 'a long area continues in further entries');
    assert.equal(result.qaReport.moreChecks!.length, 3, 'the rest move to moreChecks, none is dropped');
    assert.equal(result.qaReport.qaChecks.length, 18);
    assert.equal(result.cluster!.triggers!.length, 18);
    assert.deepEqual(result.cluster!.triggers!.filter(t => !t.main).map(t => t.check), result.qaReport.moreChecks);
    assert.ok(result.markdownReport.includes('If time allows (3 more inputs'), 'the overflow is visible to the tester');
    assert.equal(result.cluster!.checksIn, result.cluster!.checksOut);
    const uncapped = await generateQAReport(repo.evidence, context, { client: fakeProvider().client, model: 'offline' }, { cluster: { read, triggers: true, triggerCap: 100 } });
    assert.equal(uncapped.qaReport.qaChecks.length, 21);
    assert.equal(uncapped.qaReport.moreChecks, undefined);
  } finally { repo.cleanup(); }
});

test('a failed trigger call never fails its group', async t => {
  quiet(t);
  const repo = repoWith(3, 6);
  try {
    const result = await generateQAReport(repo.evidence, context, { client: fakeProvider({ failTriggers: true }).client, model: 'offline' }, { cluster: { retryDelayMs: 0, triggers: true } });
    assert.equal(result.qaReport.qaChecks.length, 3);
    assert.equal(result.qaReport.notCovered, undefined);
    assert.ok(result.cluster!.groups.every(g => g.ok && g.triggers === 0 && /refused triggers/.test(g.triggerError ?? '')));
  } finally { repo.cleanup(); }
});

test('trigger checks rank by changed lines, then blast radius, and only exact repeats are dropped', () => {
  const impact = (id: string, lines: number, blast: number) => ({ changedEntity: { id }, change: { changedLines: Array.from({ length: lines }, (_, i) => i + 1) }, blastRadius: { totalAffectedEntities: blast } }) as unknown as EntityImpact;
  const trigger = (id: string) => ({ changedFunction: id, behaviourChange: 'x', input: 'x', before: 'x', after: 'x', check: `Verify input ${id.length} for ${id.replace(/\W/g, ' ')}.` });
  const ranked = rankTriggers([trigger('a'), trigger('bb'), trigger('ccc'), trigger('dddd')], [impact('a', 1, 50), impact('bb', 9, 0), impact('ccc', 1, 99), impact('dddd', 9, 3)]);
  assert.deepEqual(ranked.map(t => t.changedFunction), ['dddd', 'bb', 'ccc', 'a']);
  const base: ImpactReport = { summary: 'S.', keyChanges: ['K.'], qaChecks: [ranked[1]!.check], uncertainty: [], testAreas: [area('Page', [ranked[1]!.check])] };
  const { report, placed } = placeTriggers(base, ranked, 1);
  assert.deepEqual(placed.map(p => [p.changedFunction, p.main]), [['dddd', true], ['ccc', false], ['a', false]], 'the repeat of a report check is not added twice');
  assert.deepEqual(report.qaChecks, [ranked[1]!.check, ranked[0]!.check]);
  assert.deepEqual(report.moreChecks, [ranked[2]!.check, ranked[3]!.check]);
});
