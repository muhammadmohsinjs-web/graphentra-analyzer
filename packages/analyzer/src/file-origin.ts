export type FileOrigin = 'source' | 'generated' | 'vendored' | 'minified' | 'build_output';

export interface FileAttributes { generated?: boolean; vendored?: boolean }

const BUILD_DIRECTORIES = new Set(['dist', 'build', '.next', 'out']);
const VENDORED_DIRECTORIES = new Set(['vendor', 'node_modules']);
const GENERATED_DIRECTORIES = new Set(['__generated__']);
const GENERATED_NAME = /\.(generated|gen|pb)\./i;
const HEADER_MARKER = /@generated|do not edit|auto-generated/i;
const MINIFIED_AVERAGE_LINE = 500;
const MINIFIED_MAX_LINE = 10_000;

/** Order: .gitattributes, path patterns, header markers, minified heuristic. TODO(P5-5): graphentra.yml overrides come first. */
export function classifyFileOrigin(file: string, options: { attributes?: FileAttributes; content?: string } = {}): FileOrigin {
  const { attributes, content } = options;
  if (attributes?.generated) return 'generated';
  if (attributes?.vendored) return 'vendored';
  const segments = file.replace(/\\/g, '/').split('/');
  const directories = segments.slice(0, -1);
  const name = segments.at(-1) ?? '';
  if (directories.some(part => BUILD_DIRECTORIES.has(part))) return 'build_output';
  if (directories.some(part => VENDORED_DIRECTORIES.has(part))) return 'vendored';
  if (directories.some(part => GENERATED_DIRECTORIES.has(part)) || GENERATED_NAME.test(name)) return 'generated';
  if (/\.min\.js$/i.test(name)) return 'minified';
  if (content === undefined) return 'source';
  if (content.split('\n', 5).some(line => HEADER_MARKER.test(line))) return 'generated';
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some(line => line.length > MINIFIED_MAX_LINE) ||
      (lines.length > 0 && lines.reduce((sum, line) => sum + line.length, 0) / lines.length > MINIFIED_AVERAGE_LINE)) return 'minified';
  return 'source';
}
