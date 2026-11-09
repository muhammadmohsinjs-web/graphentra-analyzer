import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEXT_PACKAGE, mapFor } from './helper';

test('nextjs-pages-router: pages and pages/api endpoints', () => {
  const { map, provenance } = mapFor({
    'package.json': NEXT_PACKAGE,
    'pages/index.tsx': 'export default function Home() { return null; }\n',
    'pages/api/ping.ts': 'export default function handler() {}\n',
    'pages/_app.tsx': 'export default function App() { return null; }\n',
  });
  assert.deepEqual(map.surfaces.map(s => s.id), ['api:ANY /api/ping', 'ui:/']);
  assert.equal(provenance.get('ui:/')!.adapterId, 'nextjs-pages-router');
});
