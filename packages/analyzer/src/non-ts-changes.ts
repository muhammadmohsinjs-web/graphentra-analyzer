import type { DiagnosticItem } from './contracts';
import { compareStrings } from './deterministic';

export type NonTsChangeClass =
  | 'DEPENDENCY_CHANGE'
  | 'SCHEMA_CHANGE'
  | 'ENV_CONFIG_CHANGE'
  | 'CI_CONFIG_CHANGE'
  | 'ASSET_ONLY'
  | 'OTHER';

export type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
export interface Dep { name: string; version: string; section: DepSection }
export interface DepChange { name: string; from: string; to: string; section: DepSection }
export interface PackageJsonDiff { added: Dep[]; removed: Dep[]; changed: DepChange[] }

const SECTIONS: DepSection[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json']);
const MAX_NAMES = 20;

const isCiPath = (file: string, base: string): boolean =>
  /(^|\/)\.github\//.test(file) || /(^|\/)\.circleci\//.test(file) || base === '.gitlab-ci.yml' || /^Dockerfile/.test(base);

export const classifyNonTsFile = (file: string): NonTsChangeClass => {
  const p = file.replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  if (base === 'package.json' || LOCKFILES.has(base)) return 'DEPENDENCY_CHANGE';
  if (/\.(prisma|sql)$/i.test(base) || /(^|\/)migrations\//.test(p)) return 'SCHEMA_CHANGE';
  const ci = isCiPath(p, base);
  if (
    base.startsWith('.env') || /\.config\.[^/]+$/.test(base) || /^tsconfig[^/]*\.json$/.test(base) ||
    (!ci && /\.(ya?ml|toml|ini)$/i.test(base))
  ) return 'ENV_CONFIG_CHANGE';
  if (ci) return 'CI_CONFIG_CHANGE';
  if (/\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|css|scss)$/.test(lower)) return 'ASSET_ONLY';
  return 'OTHER';
};

const parseDeps = (text: string): Map<string, Dep> | null => {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const out = new Map<string, Dep>();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const section of SECTIONS) {
    const block = (json as Record<string, unknown>)[section];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, version] of Object.entries(block)) {
      out.set(`${section}\0${name}`, { name, version: String(version), section });
    }
  }
  return out;
};

const byNameSection = (a: { name: string; section: string }, b: { name: string; section: string }): number =>
  compareStrings(a.name, b.name) || compareStrings(a.section, b.section);

export const diffPackageJson = (base: string | undefined, head: string | undefined): PackageJsonDiff | null => {
  const b = base === undefined ? new Map<string, Dep>() : parseDeps(base);
  const h = head === undefined ? new Map<string, Dep>() : parseDeps(head);
  if (!b || !h) return null;
  const added: Dep[] = [];
  const removed: Dep[] = [];
  const changed: DepChange[] = [];
  for (const [key, dep] of h) {
    const old = b.get(key);
    if (!old) added.push(dep);
    else if (old.version !== dep.version) changed.push({ name: dep.name, from: old.version, to: dep.version, section: dep.section });
  }
  for (const [key, dep] of b) if (!h.has(key)) removed.push(dep);
  return { added: added.sort(byNameSection), removed: removed.sort(byNameSection), changed: changed.sort(byNameSection) };
};

const cap = (items: string[]): string => {
  const shown = items.slice(0, MAX_NAMES).join(', ');
  return items.length > MAX_NAMES ? `${shown}, and ${items.length - MAX_NAMES} more` : shown;
};

const packageJsonMessage = (diff: PackageJsonDiff | null): string => {
  if (!diff) return 'package.json changed: unparseable package.json';
  const parts: string[] = [];
  if (diff.added.length) parts.push(`added ${cap(diff.added.map((d) => `${d.name}@${d.version}`))}`);
  if (diff.removed.length) parts.push(`removed ${cap(diff.removed.map((d) => d.name))}`);
  if (diff.changed.length) parts.push(`changed ${cap(diff.changed.map((d) => `${d.name} ${d.from} → ${d.to}`))}`);
  return parts.length ? parts.join('; ') : 'package.json changed with no dependency changes';
};

const GENERIC: Record<NonTsChangeClass, string> = {
  DEPENDENCY_CHANGE: 'dependency manifest or lockfile changed',
  SCHEMA_CHANGE: 'database schema or migration changed',
  ENV_CONFIG_CHANGE: 'environment or tool configuration changed',
  CI_CONFIG_CHANGE: 'CI or container configuration changed',
  ASSET_ONLY: 'asset changed',
  OTHER: 'non-TypeScript file changed',
};

export const nonTsChangeDiagnostics = (
  files: Array<{ file: string; status?: 'added' | 'deleted' | 'modified' | 'renamed' }>,
  read: { base(file: string): string | undefined; head(file: string): string | undefined },
): DiagnosticItem[] =>
  [...files]
    .sort((a, b) => compareStrings(a.file, b.file))
    .map(({ file, status }) => {
      const code = classifyNonTsFile(file);
      const isPkg = code === 'DEPENDENCY_CHANGE' && (file.slice(file.lastIndexOf('/') + 1) === 'package.json');
      const message = isPkg
        ? packageJsonMessage(diffPackageJson(
            status === 'added' ? undefined : read.base(file),
            status === 'deleted' ? undefined : read.head(file),
          ))
        : `${GENERIC[code]}${status ? ` (${status})` : ''}`;
      return { code, severity: 'warning' as const, message, file };
    });
