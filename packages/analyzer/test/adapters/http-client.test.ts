import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapFor } from './helper';

test('http-client: fetch and axios-style calls become client requests', () => {
  const { map } = mapFor({
    'package.json': JSON.stringify({ dependencies: { express: '4.0.0' } }),
    'src/api.ts': `
      declare const axios: any;
      export async function load() {
        await fetch('/api/orders', { method: 'post' });
        await axios.get('/api/orders/1');
      }
    `,
  });
  assert.deepEqual(map.requests.map(r => [r.method, r.target]), [['POST', '/api/orders'], ['GET', '/api/orders/1']]);
});
