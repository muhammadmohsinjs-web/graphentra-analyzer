import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextjsAppRouterAdapter } from '../../src/adapters/nextjs-app-router';
import { NEXT_PACKAGE, mapFor } from './helper';

test('nextjs-app-router: app/**/page.tsx becomes a ui route', () => {
  const { map, provenance } = mapFor({
    'package.json': NEXT_PACKAGE,
    'app/orders/[id]/page.tsx': 'export default function Page() { return null; }\n',
  });
  assert.deepEqual(map.surfaces.map(s => [s.id, s.source]), [['ui:/orders/:id', 'next-app-router']]);
  assert.deepEqual(provenance.get('ui:/orders/:id'), { adapterId: 'nextjs-app-router', adapterVersion: nextjsAppRouterAdapter.version });
  assert.equal('provenance' in map, false);
});
