import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapFor } from './helper';

test('http-router: Fastify-style register prefix and chained router.route()', () => {
  const { map, provenance } = mapFor({
    'package.json': JSON.stringify({ dependencies: { fastify: '4.0.0' } }),
    'src/server.ts': `
      declare function fastify(): any;
      declare function Router(): any;
      declare function requireAuth(req: any, res: any, next: any): void;
      const app = fastify();
      const plugin = Router();
      plugin.route({ method: 'GET', url: '/ping', handler: () => 'pong' });
      plugin.route('/items').post(requireAuth, (req: any, res: any) => res.json({}));
      app.register(plugin, { prefix: '/v1' });
    `,
  });
  assert.deepEqual(map.surfaces.map(s => s.id), ['api:GET /v1/ping', 'api:POST /v1/items']);
  assert.equal(provenance.get('api:GET /v1/ping')!.adapterId, 'http-router');
});
