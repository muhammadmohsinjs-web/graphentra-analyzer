/**
 * Language-neutral entity identity grammar.
 *
 * ID = `${file}#${qualifiedName}`; split at the LAST `#` (file paths may contain `#`).
 * Qualified name segments are joined by `.` (member of container) and `>` (nested in enclosing entity).
 * Reserved literal segments: `<module>` and `default`.
 * Raw names percent-encode `# . > < ( ) , ~ %` and space as `%XX` (uppercase hex); everything else is kept.
 * Accessors: `get x` / `set x` (literal prefix, one unescaped space, escaped name).
 * Overloads (Java/C#/Kotlin only): `name(T1,T2)`, each type escaped, joined by a literal `,`.
 * Duplicate IDs get `~2`, `~3`, ... in source order (`~` is escaped in names, so no collisions).
 */

export const MODULE_SEGMENT = '<module>';
export const DEFAULT_EXPORT_SEGMENT = 'default';

const ESCAPED_CHARS = new Set(['#', '.', '>', '<', '(', ')', ',', '~', '%', ' ']);

export function escapeSegment(raw: string): string {
  let out = '';
  for (const ch of raw) {
    out += ESCAPED_CHARS.has(ch) ? `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : ch;
  }
  return out;
}

export function unescapeSegment(escaped: string): string {
  return escaped.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export const memberName = (container: string, member: string): string => `${container}.${member}`;

export const nestedName = (outer: string, inner: string): string => `${outer}>${inner}`;

export const accessorSegment = (kind: 'get' | 'set', rawName: string): string => `${kind} ${escapeSegment(rawName)}`;

export const overloadSegment = (rawName: string, rawParamTypes: readonly string[]): string =>
  `${escapeSegment(rawName)}(${rawParamTypes.map(escapeSegment).join(',')})`;

export const buildEntityId = (file: string, qualifiedName: string): string => `${file}#${qualifiedName}`;

export function parseEntityId(id: string): { file: string; qualifiedName: string } {
  const index = id.lastIndexOf('#');
  if (index < 0) throw new Error(`Invalid entity id (missing '#'): ${id}`);
  return { file: id.slice(0, index), qualifiedName: id.slice(index + 1) };
}

export function createIdAllocator(): { allocate(baseId: string): { id: string; disambiguated: boolean } } {
  const counts = new Map<string, number>();
  return {
    allocate(baseId: string) {
      const count = (counts.get(baseId) ?? 0) + 1;
      counts.set(baseId, count);
      return count === 1 ? { id: baseId, disambiguated: false } : { id: `${baseId}~${count}`, disambiguated: true };
    },
  };
}
