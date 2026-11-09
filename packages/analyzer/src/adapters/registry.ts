import { compareStrings } from '../deterministic';
import { expressDeclarativeAdapter } from './express-declarative';
import { httpRouterAdapter } from './http-router';
import { nestjsAdapter } from './nestjs';
import { nextjsAppRouterAdapter } from './nextjs-app-router';
import { nextjsPagesRouterAdapter } from './nextjs-pages-router';
import { nextjsRouteHandlerAdapter } from './nextjs-route-handler';
import { reactRouterAdapter } from './react-router';
import { routeConfigAdapter } from './route-config';
import type { FrameworkAdapter } from './types';

/** Every built-in adapter, sorted by id so iteration order never depends on import order. */
export const ADAPTERS: readonly FrameworkAdapter[] = [
  expressDeclarativeAdapter, httpRouterAdapter, nestjsAdapter, nextjsAppRouterAdapter, nextjsPagesRouterAdapter,
  nextjsRouteHandlerAdapter, reactRouterAdapter, routeConfigAdapter,
].sort((a, b) => compareStrings(a.id, b.id));
