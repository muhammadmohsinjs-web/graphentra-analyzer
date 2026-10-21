import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyzeRepository } from '../src/analyze';
import { formatDeterministicMarkdown } from '../src/output';
import { createRepo } from './helpers/git-fixture';

const MODERN_APP = path.resolve(__dirname, '../../../fixtures/modern-app');

function editOrderRow(engine: 'legacy' | 'extended') {
  const repo = createRepo('graphentra-typed-paths-');
  try {
    for (const entry of ['src', 'package.json', 'tsconfig.json']) {
      fs.cpSync(path.join(MODERN_APP, entry), path.join(repo.dir, entry), { recursive: true });
    }
    repo.git(['add', '-A']);
    repo.git(['commit', '-m', 'base']);
    const file = path.join(repo.dir, 'src/components/OrderRow.tsx');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('className="order-row"', 'className="order-row active"'));
    return analyzeRepository({ target: repo.dir, comparison: { mode: 'working-tree' }, engine });
  } finally {
    repo.cleanup();
  }
}

test('extended: a leaf component edit reaches its page through typed steps', () => {
  const result = editOrderRow('extended');
  const impact = result.impacts.find(item => item.changedEntity.name === 'OrderRow');
  assert.ok(impact, 'OrderRow is a changed entity');
  for (const recorded of impact.blastRadius.paths) assert.equal(recorded.stepTypes?.length, recorded.depth);
  const toPage = impact.blastRadius.paths.find(recorded => recorded.target.name === 'OrdersPage');
  assert.ok(toPage, 'OrdersPage is in the blast radius');
  assert.equal(toPage.stepTypes![0], 'RENDERS');

  const markdown = formatDeterministicMarkdown(result);
  assert.match(markdown, /^- Paths:$/m);
  assert.match(markdown, /^ {2}- `OrderRow` → rendered by `[^`]+`.* → [a-z ]+ `OrdersPage`$/m);
});

test('legacy: paths carry no step types and the report has no typed paths', () => {
  const result = editOrderRow('legacy');
  assert.ok(result.impacts.every(impact => impact.blastRadius.paths.every(recorded => recorded.stepTypes === undefined)));
  assert.doesNotMatch(formatDeterministicMarkdown(result), /Paths:/);
});
