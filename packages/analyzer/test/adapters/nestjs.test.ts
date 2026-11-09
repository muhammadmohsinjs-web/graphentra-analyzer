import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapFor } from './helper';

test('nestjs: controller methods with guards and roles', () => {
  const { map, provenance } = mapFor({
    'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '10.0.0' } }),
    'src/orders.controller.ts': `
      declare function Controller(path?: string): ClassDecorator;
      declare function Get(path?: string): MethodDecorator;
      declare function Post(path?: string): MethodDecorator;
      declare function UseGuards(...guards: unknown[]): ClassDecorator & MethodDecorator;
      declare function Roles(...roles: string[]): MethodDecorator;
      declare class AuthGuard {}
      @Controller('orders') @UseGuards(AuthGuard)
      export class OrdersController {
        @Get(':id') find() {}
        @Post() @Roles('admin') create() {}
      }
    `,
  });
  assert.deepEqual(map.surfaces.map(s => s.id), ['api:GET /orders/:id', 'api:POST /orders']);
  assert.ok(map.surfaces[1]!.access.some(hint => hint.kind === 'role' && hint.value === 'admin'));
  assert.ok(map.platform.frameworks.includes('nestjs'));
  assert.equal(provenance.get('api:POST /orders')!.adapterId, 'nestjs');
});
