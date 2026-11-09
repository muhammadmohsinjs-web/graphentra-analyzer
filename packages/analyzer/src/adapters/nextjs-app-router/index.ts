import { ADAPTER_VERSION, detectByDependency, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';
import { matchAppFile, segmentsToRoute } from '../nextjs-files';

/** Next.js App Router `app/**\/page.tsx` pages. */
export const nextjsAppRouterAdapter: FrameworkAdapter = {
  id: 'nextjs-app-router',
  version: ADAPTER_VERSION,
  frameworks: ['next'],
  detect: ctx => detectByDependency(ctx, ['next']),
  surfaces(ctx: AdapterContext): DetectedSurface[] {
    const found: DetectedSurface[] = [];
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
