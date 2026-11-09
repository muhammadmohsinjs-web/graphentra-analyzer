import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTERS } from '../../src/adapters/registry';

test('registry: eight adapters sorted by id with unique ids and semver versions', () => {
  const ids = ADAPTERS.map(adapter => adapter.id);
  assert.deepEqual(ids, ['express-declarative', 'http-router', 'nestjs', 'nextjs-app-router', 'nextjs-pages-router',
    'nextjs-route-handler', 'react-router', 'route-config']);
  for (const adapter of ADAPTERS) assert.match(adapter.version, /^\d+\.\d+\.\d+$/);
});
