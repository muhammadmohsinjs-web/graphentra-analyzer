import { ADAPTER_VERSION, detectByDependency, type AdapterContext, type DetectedSurface, type FrameworkAdapter } from '../types';
import { matchPagesFile, segmentsToRoute } from '../nextjs-files';

/** Next.js Pages Router `pages/**` pages and `pages/api/**` endpoints. */
export const nextjsPagesRouterAdapter: FrameworkAdapter = {
  id: 'nextjs-pages-router',
  version: ADAPTER_VERSION,
  frameworks: ['next'],
  detect: ctx => detectByDependency(ctx, ['next']),
  surfaces(ctx: AdapterContext): DetectedSurface[] {
    const found: DetectedSurface[] = [];
    for (const { sourceFile, file, index, dependencies } of ctx.files) {
      if (!dependencies.has('next')) continue;
      const relativePage = matchPagesFile(file);
      if (relativePage === undefined) continue;
      if (/(^|\/)_(app|document|error|middleware)$/.test(relativePage)) continue;
      const route = segmentsToRoute(relativePage.replace(/(^|\/)index$/, ''));
      const entrySymbol = ctx.sourceFileExport(sourceFile, 'default');
      if (!entrySymbol) continue;
      const isApi = /^api(\/|$)/.test(relativePage);
      found.push({ kind: isApi ? 'api_endpoint' : 'ui_route', route, method: isApi ? 'ANY' : undefined,
        source: 'next-pages-router', node: sourceFile, entrySymbol, access: [], labels: [], order: [0, index, -1] });
    }
    return found;
  },
};
