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
    .filter(segment => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@') && !segment.startsWith('_'))
    .map(normalizeNextSegment));
}

/** Major version of `next` detected for the project, or undefined when unknown. */
export function nextMajor(frameworkVersions: ReadonlyArray<{ framework: string; major?: number }> | undefined): number | undefined {
  return frameworkVersions?.find(detection => detection.framework === 'next')?.major;
}
