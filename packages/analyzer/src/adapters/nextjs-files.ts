import { joinRoute } from '../application-map-ast';

// File-system routing conventions shared by the three Next.js adapters.
export const NEXT_HANDLER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function matchAppFile(file: string): { directory: string; kind: 'page' | 'route' } | undefined {
  const match = /(?:^|\/)app\/((?:.*\/)?)(page|route)\.tsx?$/.exec(file);
  return match ? { directory: match[1]!, kind: match[2] as 'page' | 'route' } : undefined;
}

export function matchPagesFile(file: string): string | undefined {
  if (matchAppFile(file)) return undefined;
  return /(?:^|\/)pages\/(.+)\.tsx?$/.exec(file)?.[1];
}

/**
 * Next.js dynamic segments in the route's common `:param` form: `[id]` → `:id`, and both catch-all
 * `[...slug]` and optional catch-all `[[...slug]]` → `:slug*`. Other segments are kept as written.
 */
export function normalizeNextSegment(segment: string): string {
  const catchAll = /^\[\[?\.\.\.([^\]]+)\]\]?$/.exec(segment);
  if (catchAll) return `:${catchAll[1]}*`;
  const dynamic = /^\[([^\].]+)\]$/.exec(segment);
  return dynamic ? `:${dynamic[1]}` : segment;
}

export function segmentsToRoute(value: string): string {
  return joinRoute(...value.split('/')
    .filter(segment => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@') && !segment.startsWith('_')));
}

/**
 * The 3.0 projection of a Next.js route (D4): dynamic segments in `:param` form. The application map keeps the
 * `[id]` form of the 2.x output.
 */
export function normalizeNextRoute(route: string): string {
  return route.split('/').map(normalizeNextSegment).join('/');
}

