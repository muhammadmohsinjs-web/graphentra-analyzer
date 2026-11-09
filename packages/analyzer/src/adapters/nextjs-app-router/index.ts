import { ADAPTER_VERSION, detectByDependency, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';
import { matchAppFile, nextMajor, segmentsToRoute } from '../nextjs-files';
import { nextRouterRules } from '../../framework-version';

/** Next.js App Router `app/**\/page.tsx` pages. */
export const nextjsAppRouterAdapter: FrameworkAdapter = {
  id: 'nextjs-app-router',
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
      if (match?.kind !== 'page') continue;
      const entrySymbol = ctx.sourceFileExport(sourceFile, 'default');
      if (entrySymbol) {
        found.push({ kind: 'ui_route', route: segmentsToRoute(match.directory), source: 'next-app-router', node: sourceFile, entrySymbol,
          access: [], labels: [], order: [0, index, -1] });
      }
    }
    return found;
  },
};
