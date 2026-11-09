import { ADAPTER_VERSION, detectByDependency, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';
import { NEXT_HANDLER_METHODS, matchAppFile, nextMajor, segmentsToRoute } from '../nextjs-files';
import { nextRouterRules } from '../../framework-version';

/** Next.js App Router `app/**\/route.ts` handlers exporting HTTP-method functions. */
export const nextjsRouteHandlerAdapter: FrameworkAdapter = {
  id: 'nextjs-route-handler',
  version: ADAPTER_VERSION,
  frameworks: ['next'],
  detect: ctx => detectByDependency(ctx, ['next']),
  surfaces(ctx: AdapterContext): DetectedSurface[] {
    const found: DetectedSurface[] = [];
    // D11: the app/ directory is a router only from Next.js 13 on (unknown major: assume it is).
    if (!nextRouterRules(nextMajor(ctx.frameworkVersions)).appRouter) return found;
    for (const { sourceFile, file, index, dependencies } of ctx.files) {
      if (!dependencies.has('next')) continue;
      const match = matchAppFile(file);
      if (match?.kind !== 'route') continue;
      const route = segmentsToRoute(match.directory);
      for (const method of NEXT_HANDLER_METHODS) {
        const entrySymbol = ctx.sourceFileExport(sourceFile, method);
        if (entrySymbol) {
          found.push({ kind: 'api_endpoint', route, method, source: 'next-route-handler', node: sourceFile, entrySymbol,
            access: [], labels: [], order: [0, index, -1] });
        }
      }
    }
    return found;
  },
};
