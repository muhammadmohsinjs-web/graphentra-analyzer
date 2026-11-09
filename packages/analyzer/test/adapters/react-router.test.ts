import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapFor } from './helper';

test('react-router: JSX <Route> trees with nested paths and guards', () => {
  const { map, provenance } = mapFor({
    'package.json': JSON.stringify({ dependencies: { 'react-router-dom': '6.0.0', react: '18.0.0' } }),
    'src/App.tsx': `
      declare const Route: any, Routes: any, RequireAuth: any;
      function Orders() { return null; }
      function Detail() { return null; }
      export function App() {
        return <Routes><Route path="/orders" element={<RequireAuth><Orders /></RequireAuth>}><Route path=":id" element={<Detail />} /></Route></Routes>;
      }
    `,
  });
  assert.deepEqual(map.surfaces.map(s => [s.id, s.source]), [['ui:/orders', 'jsx-route'], ['ui:/orders/:id', 'jsx-route']]);
  assert.ok(map.surfaces[0]!.access.some(hint => hint.value === 'RequireAuth'));
  assert.equal(provenance.get('ui:/orders')!.adapterId, 'react-router');
});
