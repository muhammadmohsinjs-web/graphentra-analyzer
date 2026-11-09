import { routerSurfaces } from '../router-model';
import { ADAPTER_VERSION, detectByDependency, detectSyntactic, type FrameworkAdapter } from '../types';
import { ADAPTER_ID } from './rules';

/** Express-style `app.get('/x', handler)` registration and `app.use('/prefix', router)` mounting. */
export const expressDeclarativeAdapter: FrameworkAdapter = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  frameworks: ['express'],
  detect: ctx => {
    const declared = detectByDependency(ctx, ['express']);
    return declared.present ? declared : detectSyntactic();
  },
  surfaces: ctx => routerSurfaces(ctx, ADAPTER_ID),
};
