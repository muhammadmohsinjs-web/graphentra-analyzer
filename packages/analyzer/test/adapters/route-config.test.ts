import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapFor } from './helper';

test('route-config: nested route objects and redirects', () => {
  const { map, provenance } = mapFor({
    'package.json': JSON.stringify({ dependencies: { 'react-router-dom': '6.0.0' } }),
    'src/routes.tsx': `
      function Home() { return null; }
      function Team() { return null; }
      export const routes = [
        { path: '/', element: <Home /> },
        { path: '/admin', children: [{ path: 'team', element: <Team />, title: 'Team' }] },
        { path: '/old', redirectTo: '/' },
      ];
    `,
  });
  assert.deepEqual(map.surfaces.map(s => [s.id, s.source]), [['ui:/', 'route-config'], ['ui:/admin/team', 'route-config']]);
  assert.equal(provenance.get('ui:/admin/team')!.adapterId, 'route-config');
  assert.ok(map.navigation.some(link => link.kind === 'redirect' && link.target === '/'));
});
