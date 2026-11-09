import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPRESS_RULES } from '../../src/adapters/express-declarative/rules';
import { mapFor } from './helper';

test('express-declarative: verb registration, router mounting, and middleware guards', () => {
  const { map, provenance } = mapFor({
    'package.json': JSON.stringify({ dependencies: { express: '4.0.0' } }),
    'src/server.ts': `
      declare function express(): any;
      declare function requireAuth(req: any, res: any, next: any): void;
      const app = express();
      const router = express();
      router.get('/:id', (req: any, res: any) => res.json({}));
      router.post('/', requireAuth, (req: any, res: any) => res.json({}));
      app.use('/api/orders', router);
    `,
  });
  assert.deepEqual(map.surfaces.map(s => s.id), ['api:GET /api/orders/:id', 'api:POST /api/orders']);
  assert.ok(map.surfaces[1]!.access.some(hint => hint.value === 'requireAuth'));
  assert.equal(provenance.get('api:POST /api/orders')!.adapterId, 'express-declarative');
  assert.deepEqual(EXPRESS_RULES.map(rule => rule.kind), ['route', 'mount', 'guard']);
});
