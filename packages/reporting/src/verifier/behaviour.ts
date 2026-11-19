import type { EntityImpact } from '@graphentra/analyzer';

// Phase V (ADR-0011), V-13b: decide, without a model, that a change cannot alter runtime behaviour.
// Conservative by design (objective: never miss a bug). It only says "no behaviour change" when the old and new code are
// equal after removing text that cannot run: comments, `import … from` lines, type and interface declarations, type-only
// members, `readonly`, `x as T` casts, the const/let/var choice and formatting. Side-effect imports (`import "./x.css"`)
// and re-exports stay behaviour. When unsure it returns false, and the entity is asked about as before.

const IMPORT_FROM = /^import\b(?!\s*["'(])/; // not `import "x.css"` (side effect) and not dynamic `import(`
const TYPE_DECL = /^(export\s+)?(declare\s+)?(type|interface)\s+[\w$]+/;
const TYPE_MEMBER = /^(?!default\b)(readonly\s+)?[\w$]+\??\s*:\s*[^=(){}]+;$/; // `className?: string;`, no initializer
const BARE_NAME = /^(type\s+)?[\w$]+(\s+as\s+[\w$]+)?,?$/; // a name inside a multi-line import list
const IMPORT_OPEN = /^import\s+(type\s+)?([\w$]+\s*,\s*)?\{[^}]*$/; // `import {` with the names on the next lines
const FROM = /^\}?\s*from\s+["']|\}\s*from\s+["']/;

export interface ImportListNames {
  removed: Map<string, number>;
  added: Map<string, number>;
}

/**
 * Bare-name lines (`  foo,`) that the file diff shows inside an `import { … } from` block, counted per side. Only a block
 * whose `import {` line is visible counts: a list whose opener is outside the hunk could be a re-export or an array, so
 * its names stay behaviour.
 */
export function importListNames(diff: string | undefined): ImportListNames {
  const result: ImportListNames = { removed: new Map(), added: new Map() };
  const state = { removed: false, added: false };
  for (const raw of (diff ?? '').split('\n')) {
    if (raw.startsWith('@@') || raw.startsWith('---') || raw.startsWith('+++')) { state.removed = state.added = false; continue; }
    const sign = raw[0];
    if (sign !== ' ' && sign !== '-' && sign !== '+') continue;
    const line = raw.slice(1).trim();
    for (const side of ['removed', 'added'] as const) {
      const mine = side === 'removed' ? '-' : '+';
      if (sign !== ' ' && sign !== mine) continue;
      if (!state[side]) { if (IMPORT_OPEN.test(line)) state[side] = true; continue; }
      if (FROM.test(line)) state[side] = false;
      else if (BARE_NAME.test(line)) { if (sign === mine) result[side].set(line, (result[side].get(line) ?? 0) + 1); }
      else if (line && !line.startsWith('//')) state[side] = false;
    }
  }
  return result;
}

// Bracket balance inside a type declaration; `=>` in a function type is not a closing `>`.
const braces = (line: string) => {
  const text = line.replace(/=>/g, '');
  return (text.match(/[{(<\[]/g)?.length ?? 0) - (text.match(/[})>\]]/g)?.length ?? 0);
};

/** The code lines that can run, one string. Exported for tests. */
export function behaviourText(code: string[], { importNames }: { importNames?: Map<string, number> } = {}): string {
  const lines = code.map(line => line.trim());
  const names = new Map(importNames ?? []);
  const kept: string[] = [];
  let inComment = false;
  let inImport = false;
  let typeDepth = 0;
  let inTypeAlias = false;
  for (const line of lines) {
    if (inComment) { if (line.includes('*/')) inComment = false; continue; }
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('/*')) { if (!line.includes('*/')) inComment = true; continue; }
    if (inImport) {
      // Inside an `import {` opened in these lines: names until `} from`. Anything else ends it and is read normally.
      if (FROM.test(line)) { inImport = false; continue; }
      if (BARE_NAME.test(line)) continue;
      inImport = false;
    }
    if (IMPORT_FROM.test(line)) { if (IMPORT_OPEN.test(line)) inImport = true; continue; }
    if (typeDepth > 0 || inTypeAlias) {
      typeDepth = Math.max(0, typeDepth + braces(line));
      inTypeAlias = typeDepth > 0 || /[=|&,]$/.test(line);
      continue;
    }
    if (TYPE_DECL.test(line)) {
      typeDepth = Math.max(0, braces(line));
      inTypeAlias = typeDepth > 0 || /[=|&,]$/.test(line);
      continue;
    }
    if (TYPE_MEMBER.test(line)) continue;
    // A bare name is skipped only as often as the diff shows it inside an import list on this side.
    const left = names.get(line) ?? 0;
    if (left > 0 && BARE_NAME.test(line)) { names.set(line, left - 1); continue; }
    kept.push(line);
  }
  let text = kept.join('\n')
    .replace(/\breadonly\s+/g, '')
    .replace(/\b(const|let|var)\b/g, 'let')
    .replace(/'/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/ (?=\W)|(?<=\W) /g, '')
    .replace(/;/g, '')
    .replace(/,(?=[)\]}])/g, '');
  // `(x as T)`: drop the cast, then parentheses around a plain name. Repeat for nested casts.
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/([\w$\])])\s*as\s*(const|[A-Za-z_$][\w$.]*(<[^<>()]*>)?(\[\])*)(?=\))/g, '$1').replace(/\(([\w$.]+)\)/g, '$1');
  }
  // `=> { return x }` is the same as `=> x`.
  return text.replace(/=>\{return ?([^{}]*)\}/g, '=>$1');
}

/** True only when the change provably has no runtime effect (see the file comment). */
export function hasNoBehaviourChange(impact: EntityImpact): boolean {
  const as = (code: unknown) => (Array.isArray(code) ? code.map(String) : typeof code === 'string' ? code.split('\n') : []);
  const names = importListNames(impact.change.diff);
  return behaviourText(as(impact.change.removedCode), { importNames: names.removed }) === behaviourText(as(impact.change.addedCode), { importNames: names.added });
}

/** `file#A>b>c` → `file#A>b`. Undefined for top-level entities, `<module>` and class members (`A.m`). */
export function innerParentId(id: string): string | undefined {
  const hash = id.lastIndexOf('#');
  const name = id.slice(hash + 1);
  if (hash < 0 || name.startsWith('<')) return undefined;
  const cut = name.lastIndexOf('>');
  return cut > 0 ? `${id.slice(0, hash + 1)}${name.slice(0, cut)}` : undefined;
}
