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

export function segmentsToRoute(value: string): string {
  return joinRoute(...value.split('/')
    .filter(segment => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@') && !segment.startsWith('_')));
}
