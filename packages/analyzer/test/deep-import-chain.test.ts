import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { validateEvidenceEnvelope } from '../src/validator';
import { createRepo } from './helpers/git-fixture';

/** D16: ts.createProgram recurses once per import level; a 2,000-deep chain overflowed the stack before leaves-first roots. */
test('a 2,000-file deep import chain analyzes without exhausting the stack', () => {
  const repo = createRepo('graphentra-deep-chain-');
  try {
    const depth = 2000;
    fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2020', module: 'commonjs' }, include: ['src'] }));
    fs.mkdirSync(path.join(repo.dir, 'src'));
    // m0 imports m1, which imports m2, ...: the first root pulls in the whole chain.
    for (let i = 0; i < depth; i++) {
      const last = i === depth - 1;
      fs.writeFileSync(path.join(repo.dir, 'src', `m${i}.ts`), last
        ? `export function fn${i}(x: number): number { return x; }\n`
        : `import { fn${i + 1} } from './m${i + 1}';\nexport function fn${i}(x: number): number { return fn${i + 1}(x) + 1; }\n`);
    }
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'chain']);
    const base = repo.git(['rev-parse', 'HEAD']);
    const head = repo.commitFile(`src/m${depth - 1}.ts`, `export function fn${depth - 1}(x: number): number { return x * 2; }\n`);

    const result = analyzeRepository({ target: repo.dir, comparison: { mode: 'commit', base, head }, engine: 'extended' });

    assert.deepEqual(validateEvidenceEnvelope(result.evidence).errors, []);
    const impact = result.impacts.find(item => item.changedEntity.name === `fn${depth - 1}`);
    assert.ok(impact, 'the edited leaf is a changed entity');
    assert.ok(impact.directDependents.some(entity => entity.name === `fn${depth - 2}`));
  } finally {
    repo.cleanup();
  }
});
