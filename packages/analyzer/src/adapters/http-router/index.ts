import { routerSurfaces } from '../router-model';
import { ADAPTER_VERSION, detectByDependency, detectSyntactic, type FrameworkAdapter } from '../types';
import { ADAPTER_ID } from './rules';

/** Koa / Fastify / Hono style routers through the generic receiver.verb rule (non-declarative forms). */
export const httpRouterAdapter: FrameworkAdapter = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  frameworks: ['fastify', 'koa', '@koa/router', 'hono'],
  detect: ctx => {
    const declared = detectByDependency(ctx, ['fastify', 'koa', '@koa/router', 'hono']);
    return declared.present ? declared : detectSyntactic();
  },
  surfaces: ctx => routerSurfaces(ctx, ADAPTER_ID),
};
