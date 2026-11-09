import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEXT_PACKAGE, mapFor } from './helper';

test('nextjs-route-handler: exported HTTP methods in route.ts', () => {
  const { map, provenance } = mapFor({
    'package.json': NEXT_PACKAGE,
    'app/api/items/route.ts': 'export async function GET() { return null; }\nexport async function POST() { return null; }\n',
  });
  assert.deepEqual(map.surfaces.map(s => s.id), ['api:GET /api/items', 'api:POST /api/items']);
  assert.equal(provenance.get('api:GET /api/items')!.adapterId, 'nextjs-route-handler');
});
