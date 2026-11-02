import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { analyzeRepository } from '../src/analyze';
import { createBaselineSnapshot } from '../src/baseline-host';
import { DEFAULT_INPUT_LIMITS, inspectContent } from '../src/input-limits';
import { createRepositoryContext } from '../src/repository';
import { captureSourceSnapshot } from '../src/source-snapshot';
import { validateEvidenceEnvelope } from '../src/validator';
import { createRepo } from './helpers/git-fixture';

test('default input limits follow D9', () => {
  assert.deepEqual(DEFAULT_INPUT_LIMITS, { maxFileBytes: 2 * 1024 * 1024, maxFiles: 50_000, maxTotalBytes: 500 * 1024 * 1024 });
});

test('inspectContent: NUL in the first 8 KB is binary, invalid UTF-8 is rejected, valid UTF-8 passes', () => {
  assert.equal(inspectContent(Buffer.from('export const a = "é";')), 'ok');
  assert.equal(inspectContent(Buffer.alloc(0)), 'ok');
  assert.equal(inspectContent(Buffer.from([0x61, 0x00, 0x62])), 'binary');
  assert.equal(inspectContent(Buffer.from([0xff, 0xfe, 0x41])), 'invalid_encoding');
  // A NUL beyond the first 8 KB is not sniffed as binary.
  assert.equal(inspectContent(Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])])), 'ok');
});

test('skipped files are absent to the program; clean repositories report no skips and keep their identity', () => {
  const repo = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() {}');
    const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }));
    assert.deepEqual(snapshot.skipped, []);
    assert.deepEqual(snapshot.files, [path.join(repo.dir, 'a.ts')]);
  } finally { repo.cleanup(); }
});

test('file count and byte limits keep the first files by sorted path', () => {
  const repo = createRepo();
  try {
    for (const name of ['c.ts', 'a.ts', 'b.ts']) fs.writeFileSync(path.join(repo.dir, name), `export const ${name[0]} = 1;`);
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'files']);
    const context = createRepositoryContext(repo.dir, { mode: 'working-tree' });
    const byCount = captureSourceSnapshot(context, 'extended', { ...DEFAULT_INPUT_LIMITS, maxFiles: 2 });
    assert.deepEqual(byCount.files.map(file => path.basename(file)), ['a.ts', 'b.ts']);
    assert.deepEqual(byCount.skipped, [{ file: 'c.ts', reason: 'input_limit' }]);
    const size = Buffer.byteLength('export const a = 1;');
    const byBytes = captureSourceSnapshot(context, 'extended', { ...DEFAULT_INPUT_LIMITS, maxTotalBytes: size * 2 });
    assert.deepEqual(byBytes.files.map(file => path.basename(file)), ['a.ts', 'b.ts']);
    assert.deepEqual(byBytes.skipped, [{ file: 'c.ts', reason: 'input_limit' }]);
  } finally { repo.cleanup(); }
});

test('a skipped symlink to an outside file is recorded instead of failing the analysis', () => {
  const repo = createRepo();
  const external = createRepo();
  try {
    repo.commitFile('a.ts', 'export function a() {}');
    external.commitFile('external.ts', 'export function external() {}');
    fs.symlinkSync(path.join(external.dir, 'external.ts'), path.join(repo.dir, 'linked.ts'));
    const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }));
    assert.deepEqual(snapshot.skipped, [{ file: 'linked.ts', reason: 'symlink' }]);
    assert.doesNotThrow(() => snapshot.verify());
    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' } });
    assert.deepEqual(result.technicalGraph.analyzedFiles, ['a.ts']);
  } finally { repo.cleanup(); external.cleanup(); }
});

test('baseline snapshot applies the same size, binary and encoding checks', () => {
  const repo = createRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, 'ok.ts'), 'export function ok() {}');
    fs.writeFileSync(path.join(repo.dir, 'big.ts'), `export const big = "${'x'.repeat(3 * 1024 * 1024)}";`);
    fs.writeFileSync(path.join(repo.dir, 'bin.ts'), Buffer.from([0x61, 0x00, 0x62]));
    fs.writeFileSync(path.join(repo.dir, 'bad.ts'), Buffer.from([0x61, 0xff, 0xfe]));
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    const sha = repo.git(['rev-parse', 'HEAD']);
    const baseline = createBaselineSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }), sha, 'extended');
    assert.deepEqual(baseline.files.map(file => path.basename(file)), ['ok.ts']);
    assert.deepEqual(baseline.skipped, [
      { file: 'bad.ts', reason: 'invalid_encoding' },
      { file: 'big.ts', reason: 'too_large' },
      { file: 'bin.ts', reason: 'binary' },
    ]);
    assert.equal(baseline.host.readFile(path.join(repo.dir, 'big.ts')), undefined);
  } finally { repo.cleanup(); }
});

test('D10: compilerOptions.plugins in the target tsconfig is never loaded or executed', () => {
  const repo = createRepo();
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-marker-'));
  const marker = path.join(markerDir, 'executed');
  try {
    const plugin = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned');\nmodule.exports = () => ({ create: info => info.languageService });\n`;
    fs.mkdirSync(path.join(repo.dir, 'evil-plugin'));
    fs.writeFileSync(path.join(repo.dir, 'evil-plugin/index.js'), plugin);
    fs.mkdirSync(path.join(repo.dir, 'node_modules/evil-plugin'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'node_modules/evil-plugin/index.js'), plugin);
    fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { plugins: [{ name: './evil-plugin' }, { name: 'evil-plugin' }] } }));
    fs.writeFileSync(path.join(repo.dir, 'a.ts'), 'export function a() {}');
    repo.git(['add', '-A', '-f']);
    repo.git(['commit', '-m', 'plugins']);
    for (const engine of ['extended', 'legacy'] as const) {
      analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine });
      assert.equal(fs.existsSync(marker), false, `plugin executed under ${engine} engine`);
    }
  } finally { repo.cleanup(); fs.rmSync(markerDir, { recursive: true, force: true }); }
});

test('hostile repository: analysis finishes, evidence validates and every skip is recorded', () => {
  const repo = createRepo('graphentra-hostile-');
  try {
    const write = (name: string, content: string | Buffer) => fs.writeFileSync(path.join(repo.dir, name), content);
    write('ok.ts', 'export function ok() { return 1; }');
    write('big.ts', `export const big = "${'x'.repeat(3 * 1024 * 1024)}";`);
    fs.symlinkSync('loop-b.ts', path.join(repo.dir, 'loop-a.ts'));
    fs.symlinkSync('loop-a.ts', path.join(repo.dir, 'loop-b.ts'));
    fs.symlinkSync('/etc/hosts', path.join(repo.dir, 'hosts.ts'));
    write('x.ts', Buffer.from([0x65, 0x78, 0x00, 0x00, 0x01, 0x02]));
    write('bad-utf8.ts', Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0xfe, 0x0a, 0x65]));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { plugins: [{ name: './evil-plugin' }] } }));
    write('deep.ts', `export const deep = ${'('.repeat(10_000)}1${')'.repeat(10_000)};`);
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'hostile']);

    const snapshot = captureSourceSnapshot(createRepositoryContext(repo.dir, { mode: 'working-tree' }), 'extended');
    assert.deepEqual(snapshot.skipped, [
      { file: 'bad-utf8.ts', reason: 'invalid_encoding' },
      { file: 'big.ts', reason: 'too_large' },
      { file: 'hosts.ts', reason: 'symlink' },
      { file: 'loop-a.ts', reason: 'symlink' },
      { file: 'loop-b.ts', reason: 'symlink' },
      { file: 'x.ts', reason: 'binary' },
    ]);
    assert.deepEqual(snapshot.files.map(file => path.basename(file)), ['deep.ts', 'ok.ts']);
    assert.doesNotThrow(() => snapshot.verify());
    // The 10,000-level expression overflows the parser while the program is built; that must be a skip, not a crash.
    const program = ts.createProgram(snapshot.files, snapshot.compilerOptions, snapshot.host);
    assert.deepEqual(program.getSourceFiles().map(file => path.basename(file.fileName)).filter(name => name === 'deep.ts'), []);
    assert.deepEqual(snapshot.skipped.filter(item => item.reason === 'parse_failed'), [{ file: 'deep.ts', reason: 'parse_failed' }]);

    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine: 'extended' });
    assert.equal(validateEvidenceEnvelope(result.evidence).valid, true);
    assert.ok(result.technicalGraph.analyzedFiles.includes('ok.ts'));
    for (const skipped of ['big.ts', 'x.ts', 'bad-utf8.ts', 'hosts.ts', 'loop-a.ts', 'loop-b.ts']) {
      assert.ok(!result.technicalGraph.analyzedFiles.includes(skipped), `${skipped} must not be analyzed`);
    }
  } finally { repo.cleanup(); }
});
