import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareStrings } from './deterministic';

export type FrameworkPackage =
  | '@nestjs/core' | 'express' | 'fastify' | 'hono' | 'koa' | 'next' | 'react-router' | 'react-router-dom';

export interface FrameworkDetection {
  framework: FrameworkPackage;
  declared?: string;
  resolved?: string;
  major?: number;
  source: 'lockfile' | 'package.json';
  certified: boolean;
}

export const CERTIFIED_MAJORS: Record<string, number[]> = { next: [13, 14, 15], express: [4, 5] };

const FRAMEWORKS: FrameworkPackage[] = [
  '@nestjs/core', 'express', 'fastify', 'hono', 'koa', 'next', 'react-router', 'react-router-dom',
];

type ReadFile = (absPath: string) => string | undefined;

const defaultReadFile: ReadFile = (absPath) => {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return undefined; }
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Major of a declared range; undefined for non-semver specs (tags, workspace/link/file/git/url). */
export const majorFromRange = (range: string | undefined): number | undefined => {
  if (!range) return undefined;
  const r = range.trim();
  if (!r || /^(\*|x|latest|next|canary|beta|alpha|rc)$/i.test(r)) return undefined;
  if (/^(workspace|link|file|git|github|gitlab|bitbucket|http|https|portal|patch):/i.test(r) || r.includes('://') || r.includes('/')) return undefined;
  const m = /\d+/.exec(r.replace(/^npm:[^@]*@/, ''));
  return m ? Number(m[0]) : undefined;
};

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const versionString = (v: unknown): string | undefined => typeof v === 'string' && /^\d/.test(v) ? v : undefined;

const fromPackageLock = (text: string, name: string, relProject: string): string | undefined => {
  const json = parseJson(text);
  if (!isRecord(json)) return undefined;
  if (isRecord(json.packages)) {
    const pkgs = json.packages;
    const candidates = relProject ? [`${relProject}/node_modules/${name}`, `node_modules/${name}`] : [`node_modules/${name}`];
    for (const key of candidates) {
      const entry = pkgs[key];
      if (isRecord(entry)) { const v = versionString(entry.version); if (v) return v; }
    }
  }
  if (isRecord(json.dependencies)) {
    const entry = json.dependencies[name];
    if (isRecord(entry)) return versionString(entry.version);
  }
  return undefined;
};

/**
 * The `importers:` block of a pnpm lockfile whose key equals the project path relative to the lockfile dir (`.` for
 * the lockfile's own dir), reduced to its `dependencies` / `devDependencies` sections. `null` when the lockfile has
 * an `importers:` section but no matching importer (so another workspace's version is never used); undefined when
 * there is no `importers:` section (single-project lockfile).
 */
const pnpmImporterBlock = (text: string, relProject: string): string | null | undefined => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^importers:\s*$/.test(line));
  if (start < 0) return undefined;
  const wanted = relProject === '' ? '.' : relProject;
  let importerIndent: number | undefined;
  let inImporter = false;
  let sectionIndent: number | undefined;
  let keep = false;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = /^ */.exec(line)![0].length;
    if (indent === 0) break;
    importerIndent ??= indent;
    if (indent === importerIndent) {
      const key = line.trim().replace(/:\s*(\{\}\s*)?$/, '').replace(/^['"]|['"]$/g, '');
      inImporter = key === wanted;
      sectionIndent = undefined;
      keep = false;
      continue;
    }
    if (!inImporter) continue;
    sectionIndent ??= indent;
    if (indent === sectionIndent) { keep = /^(dependencies|devDependencies):\s*$/.test(line.trim()); if (keep) out.push(line); continue; }
    if (keep) out.push(line);
  }
  return out.length > 0 ? `${out.join('\n')}\n` : null;
};

const fromPnpmLock = (text: string, name: string, relProject: string): string | undefined => {
  const n = escapeRegExp(name);
  const importer = pnpmImporterBlock(text, relProject);
  const importerForms = [
    // importer form: name:\n  specifier: ...\n  version: 14.2.3(react@...)
    new RegExp(`^[ \\t]+['"]?${n}['"]?:[ \\t]*\\r?\\n[ \\t]+specifier:[^\\n]*\\n[ \\t]+version:[ \\t]*['"]?(\\d[^\\s'"(]*)`, 'm'),
    // pnpm v5 importer form: next: 14.2.3
    new RegExp(`^[ \\t]+['"]?${n}['"]?:[ \\t]+['"]?(\\d[^\\s'"(]*)`, 'm'),
  ];
  if (importer !== undefined) {
    // Workspace lockfile: only the project's own importer counts (D11: its dependencies / devDependencies).
    if (importer === null) return undefined;
    for (const re of importerForms) {
      const m = re.exec(importer);
      if (m) return m[1];
    }
    return undefined;
  }
  const forms = [
    // importer form: name:\n  specifier: ...\n  version: 14.2.3(react@...)
    new RegExp(`^[ \\t]+['"]?${n}['"]?:[ \\t]*\\r?\\n[ \\t]+specifier:[^\\n]*\\n[ \\t]+version:[ \\t]*['"]?(\\d[^\\s'"(]*)`, 'm'),
    // packages/snapshots keys: /next@14.2.3: , next@14.2.3: , 'next@14.2.3(react@18)':
    new RegExp(`^[ \\t]*['"]?/?${n}@(\\d[^\\s:('"]*)`, 'm'),
    // pnpm v5 keys: /next/14.2.3:
    new RegExp(`^[ \\t]*['"]?/${n}/(\\d[^\\s:_('"]*)`, 'm'),
    // pnpm v5 importer form: next: 14.2.3
    new RegExp(`^[ \\t]+['"]?${n}['"]?:[ \\t]+['"]?(\\d[^\\s'"(]*)`, 'm'),
  ];
  for (const re of forms) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return undefined;
};

/**
 * The version of the yarn.lock entry whose key lists the declared range (`name@range` or berry `name@npm:range`).
 * No fallback to another entry of the same package: in a workspace lockfile that would borrow another workspace's
 * version (the same rule as the pnpm importer lookup).
 */
const fromYarnLock = (text: string, name: string, declared: string | undefined): string | undefined => {
  if (declared === undefined) return undefined;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => !l.startsWith('#') && l.trim() !== '');
    const header = lines[0];
    if (!header || /^\s/.test(header)) continue;
    const specs = header.replace(/:\s*$/, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    const mine = specs.filter((s) => s.startsWith(`${name}@`)).map((s) => s.slice(name.length + 1));
    if (mine.length === 0) continue;
    const vm = /^[ \t]+version:?[ \t]+["']?([^"'\s]+)/m.exec(block);
    if (!vm) continue;
    if (mine.some((s) => s === declared || s === `npm:${declared}`)) return vm[1];
  }
  return undefined;
};

const dirsUpTo = (projectRoot: string, repoRoot: string): string[] => {
  const root = path.resolve(repoRoot);
  const dirs: string[] = [];
  let cur = path.resolve(projectRoot);
  for (;;) {
    dirs.push(cur);
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur || !path.relative(root, parent) && parent !== root) break;
    if (path.relative(root, cur).startsWith('..')) break;
    cur = parent;
  }
  return dirs;
};

export const detectFrameworkVersions = (input: {
  projectRoot: string;
  repoRoot: string;
  readFile?: (absPath: string) => string | undefined;
}): FrameworkDetection[] => {
  try {
    const read: ReadFile = input.readFile ?? defaultReadFile;
    const projectRoot = path.resolve(input.projectRoot);
    const pkg = parseJson(read(path.join(projectRoot, 'package.json')));
    if (!isRecord(pkg)) return [];
    const declaredMap = new Map<string, string>();
    // D11: dependencies and devDependencies only (dependencies wins); peerDependencies are not the project's version.
    for (const field of ['devDependencies', 'dependencies']) {
      const deps = pkg[field];
      if (!isRecord(deps)) continue;
      for (const [k, v] of Object.entries(deps)) if (typeof v === 'string') declaredMap.set(k, v);
    }
    const lockfiles: Array<{ kind: 'npm' | 'pnpm' | 'yarn'; dir: string; text: string }> = [];
    for (const dir of dirsUpTo(projectRoot, input.repoRoot)) {
      for (const [file, kind] of [['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']] as const) {
        let text: string | undefined;
        try { text = read(path.join(dir, file)); } catch { text = undefined; }
        if (text !== undefined) lockfiles.push({ kind, dir, text });
      }
    }
    const out: FrameworkDetection[] = [];
    for (const framework of FRAMEWORKS) {
      const declared = declaredMap.get(framework);
      if (declared === undefined) continue;
      let resolved: string | undefined;
      for (const lock of lockfiles) {
        try {
          const rel = path.relative(lock.dir, projectRoot).split(path.sep).join('/');
          resolved = lock.kind === 'npm' ? fromPackageLock(lock.text, framework, rel)
            : lock.kind === 'pnpm' ? fromPnpmLock(lock.text, framework, rel)
            : fromYarnLock(lock.text, framework, declared);
        } catch { resolved = undefined; }
        if (resolved) break;
      }
      const major = resolved !== undefined ? Number(/^\d+/.exec(resolved)?.[0]) : majorFromRange(declared);
      const finalMajor = major !== undefined && Number.isFinite(major) ? major : majorFromRange(declared);
      const detection: FrameworkDetection = { framework, declared, source: resolved ? 'lockfile' : 'package.json', certified: false };
      if (resolved) detection.resolved = resolved;
      if (finalMajor !== undefined) detection.major = finalMajor;
      const certifiedList = CERTIFIED_MAJORS[framework];
      detection.certified = finalMajor !== undefined && (certifiedList?.includes(finalMajor) ?? false);
      out.push(detection);
    }
    return out.sort((a, b) => compareStrings(a.framework, b.framework));
  } catch {
    return [];
  }
};

/**
 * Framework versions that apply to a project-relative file: for each framework, the nearest `package.json` from the
 * file's directory up to the project root that names it (dependencies, devDependencies or peerDependencies, the same
 * manifests that gate the adapters), resolved through the lockfile entry of that workspace. A framework named only in
 * peerDependencies of its nearest manifest has no detection (unknown major, D11); a farther manifest never fills it in.
 */
export const createFrameworkVersionResolver = (input: {
  projectRoot: string;
  repoRoot: string;
  readFile?: (absPath: string) => string | undefined;
}): ((file: string) => FrameworkDetection[]) => {
  const read: ReadFile = input.readFile ?? defaultReadFile;
  const projectRoot = path.resolve(input.projectRoot);
  const perDir = new Map<string, { named: Set<string>; detections: FrameworkDetection[] } | null>();
  const perFile = new Map<string, FrameworkDetection[]>();
  const manifestAt = (dir: string) => {
    if (perDir.has(dir)) return perDir.get(dir)!;
    let entry: { named: Set<string>; detections: FrameworkDetection[] } | null = null;
    const pkg = parseJson(read(path.join(dir, 'package.json')));
    if (isRecord(pkg)) {
      const named = new Set<string>();
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = pkg[field];
        if (isRecord(deps)) for (const name of Object.keys(deps)) named.add(name);
      }
      const detections = detectFrameworkVersions({ projectRoot: dir, repoRoot: input.repoRoot, readFile: read });
      entry = { named, detections };
    }
    perDir.set(dir, entry);
    return entry;
  };
  return (file: string): FrameworkDetection[] => {
    const start = path.dirname(path.resolve(projectRoot, file));
    const key = start;
    const cached = perFile.get(key);
    if (cached) return cached;
    const decided = new Map<string, FrameworkDetection | null>();
    const inside = !path.relative(projectRoot, start).startsWith('..');
    let cur = inside ? start : projectRoot;
    for (let guard = 0; guard < 64; guard += 1) {
      const manifest = manifestAt(cur);
      if (manifest) {
        for (const framework of FRAMEWORKS) {
          if (decided.has(framework) || !manifest.named.has(framework)) continue;
          decided.set(framework, manifest.detections.find(item => item.framework === framework) ?? null);
        }
      }
      if (cur === projectRoot) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const out = [...decided.values()].filter((item): item is FrameworkDetection => item !== null)
      .sort((a, b) => compareStrings(a.framework, b.framework));
    perFile.set(key, out);
    return out;
  };
};

export const nextRouterRules = (major?: number): { appRouter: boolean; pagesRouter: boolean } => ({
  appRouter: major === undefined || major >= 13,
  pagesRouter: true,
});

export const frameworkLabel = (d: Pick<FrameworkDetection, 'framework' | 'major'>): string | undefined => {
  if (d.major === undefined) return undefined;
  const base = d.framework === 'next' ? 'nextjs' : d.framework === '@nestjs/core' ? 'nestjs' : d.framework.replace(/^@[^/]+\//, '');
  return `${base}@${d.major}`;
};
