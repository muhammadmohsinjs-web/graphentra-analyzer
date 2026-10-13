import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDeterministicEvidenceIdentity } from '../src/index';
import { analyzeFixture, replaceOnce } from './helpers/fixture-repo';

/** Fixture determinism matrix: the same edit in two separate temp repos gives the same evidence identity. */
const edits = {
  'test-project': (f: Record<string, string>) => ({ 'src/billing.ts': replaceOnce(f['src/billing.ts'], 'amount <= 1', 'amount <= 5') }),
  'modern-app': (f: Record<string, string>) => ({ 'src/utils/format.ts': replaceOnce(f['src/utils/format.ts'], '.trim()', '.trim().normalize()') }),
} as const;

for (const fixture of ['test-project', 'modern-app'] as const) {
  for (const engine of ['legacy', 'extended'] as const) {
    test(`fixture determinism: ${fixture} (${engine}) gives the same identity across separate repositories`, () => {
      const a = analyzeFixture({ fixture, edits: edits[fixture], engine });
      const b = analyzeFixture({ fixture, edits: edits[fixture], engine });
      assert.equal(a.outcome, 'completed');
      assert.equal(computeDeterministicEvidenceIdentity(a.evidence), computeDeterministicEvidenceIdentity(b.evidence));
    });
  }
}
