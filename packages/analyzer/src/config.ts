import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node } from 'yaml';
import type { DiagnosticItem } from './contracts.js';
import { compareStrings } from './deterministic.js';

export const CONFIG_FILE_NAME = 'graphentra.yml';
export const CRITICALITY_LEVELS = ['critical', 'high', 'normal', 'low'] as const;
export const SURFACE_KINDS = [
  'api_endpoint', 'cli_command', 'graphql_operation', 'library_export', 'mobile_screen', 'queue_consumer',
  'rpc_method', 'scheduled_job', 'serverless_function', 'ui_route', 'webhook',
] as const;

export type CriticalityLevel = typeof CRITICALITY_LEVELS[number];

export interface GraphentraConfig {
  version: 1;
  criticality: Array<{ pattern: string; level: CriticalityLevel }>;
  ignore: string[];
  tests: string[];
  surfaces: Array<{ id: string; kind: string; route: string; method?: string; handler: string }>;
}

export interface LoadedGraphentraConfig {
  config?: GraphentraConfig;
  sha256?: string;
  diagnostics: DiagnosticItem[];
}

const TOP_KEYS = new Set(['version', 'criticality', 'ignore', 'tests', 'surfaces']);
const SURFACE_KEYS = new Set(['id', 'kind', 'route', 'method', 'handler']);

class ConfigError extends Error {
  constructor(readonly offset: number | undefined, reason: string) { super(reason); }
}

function defaultReadFile(absPath: string): string | undefined {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return undefined; }
}

export function loadGraphentraConfig(
  projectRoot: string,
  readFile: (absPath: string) => string | undefined = defaultReadFile,
): LoadedGraphentraConfig {
  const raw = readFile(path.join(projectRoot, CONFIG_FILE_NAME));
  if (raw === undefined) return { diagnostics: [] };
  const sha256 = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
  const lineCounter = new LineCounter();
  const where = (offset: number | undefined): string => {
    const { line, col } = lineCounter.linePos(offset ?? 0);
    return `${CONFIG_FILE_NAME}:${line}:${col}`;
  };
  const warnings: DiagnosticItem[] = [];
  const invalid = (offset: number | undefined, reason: string): LoadedGraphentraConfig => ({
    sha256,
    diagnostics: [{ code: 'CONFIG_INVALID', severity: 'error', file: CONFIG_FILE_NAME, message: `${where(offset)}: ${reason}` }],
  });
  const warnUnknown = (node: Node | null | undefined, key: string, scope: string): void => {
    warnings.push({
      code: 'CONFIG_UNKNOWN_KEY', severity: 'warning', file: CONFIG_FILE_NAME,
      message: `${where(node?.range?.[0])}: unknown key "${key}" in ${scope}`,
    });
  };

  try {
    const doc = parseDocument(raw, { lineCounter, prettyErrors: false });
    if (doc.errors.length > 0) throw new ConfigError(doc.errors[0].pos[0], `invalid YAML: ${doc.errors[0].code}: ${doc.errors[0].message.split('\n')[0]}`);
    const root = doc.contents;
    if (!isMap(root)) throw new ConfigError(root?.range?.[0] ?? 0, 'top level must be a mapping');

    const stringList = (node: unknown, key: string): string[] => {
      if (!isSeq(node)) throw new ConfigError((node as Node | null)?.range?.[0], `"${key}" must be a list of strings`);
      return node.items.map(item => {
        if (!isScalar(item) || typeof item.value !== 'string') throw new ConfigError((item as Node | null)?.range?.[0], `"${key}" entries must be strings`);
        return item.value;
      }).sort(compareStrings);
    };

    let version: unknown;
    let criticality: GraphentraConfig['criticality'] = [];
    let ignore: string[] = [];
    let tests: string[] = [];
    let surfaces: GraphentraConfig['surfaces'] = [];
    let sawVersion = false;

    for (const pair of root.items) {
      const keyNode = pair.key as Node;
      const key = isScalar(keyNode) ? String(keyNode.value) : '';
      const value = pair.value as Node | null;
      if (!TOP_KEYS.has(key)) { warnUnknown(keyNode, key, 'top level'); continue; }
      if (key === 'version') {
        sawVersion = true;
        version = isScalar(value) ? value.value : undefined;
        if (version !== 1) throw new ConfigError(value?.range?.[0] ?? keyNode.range?.[0], '"version" must be 1');
      } else if (key === 'criticality') {
        if (!isMap(value)) throw new ConfigError(value?.range?.[0] ?? keyNode.range?.[0], '"criticality" must be a mapping of pattern to level');
        criticality = value.items.map(p => {
          const pk = p.key as Node;
          const pv = p.value as Node | null;
          if (!isScalar(pk) || typeof pk.value !== 'string') throw new ConfigError(pk?.range?.[0], 'criticality pattern must be a string');
          if (!isScalar(pv) || !(CRITICALITY_LEVELS as readonly unknown[]).includes(pv.value)) {
            throw new ConfigError(pv?.range?.[0] ?? pk.range?.[0], `criticality level for "${pk.value}" must be one of ${CRITICALITY_LEVELS.join(', ')}`);
          }
          return { pattern: pk.value, level: pv.value as CriticalityLevel };
        }).sort((a, b) => compareStrings(a.pattern, b.pattern));
      } else if (key === 'ignore') {
        ignore = stringList(value, key);
      } else if (key === 'tests') {
        tests = stringList(value, key);
      } else if (key === 'surfaces') {
        if (!isSeq(value)) throw new ConfigError(value?.range?.[0] ?? keyNode.range?.[0], '"surfaces" must be a list');
        surfaces = value.items.map(item => {
          if (!isMap(item)) throw new ConfigError((item as Node | null)?.range?.[0], 'each surface must be a mapping');
          const fields: Record<string, string> = {};
          for (const p of item.items) {
            const pk = p.key as Node;
            const name = isScalar(pk) ? String(pk.value) : '';
            const pv = p.value as Node | null;
            if (!SURFACE_KEYS.has(name)) { warnUnknown(pk, name, 'surfaces item'); continue; }
            if (!isScalar(pv) || typeof pv.value !== 'string' || pv.value === '') {
              throw new ConfigError(pv?.range?.[0] ?? pk.range?.[0], `surface "${name}" must be a non-empty string`);
            }
            if (name === 'kind' && !(SURFACE_KINDS as readonly string[]).includes(pv.value)) {
              throw new ConfigError(pv.range?.[0], `surface kind "${pv.value}" must be one of ${SURFACE_KINDS.join(', ')}`);
            }
            fields[name] = pv.value;
          }
          for (const required of ['id', 'kind', 'route', 'handler']) {
            if (fields[required] === undefined) throw new ConfigError(item.range?.[0], `surface is missing required "${required}"`);
          }
          return fields as GraphentraConfig['surfaces'][number];
        }).sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.method ?? '', b.method ?? '') || compareStrings(a.route, b.route));
      }
    }
    if (!sawVersion) throw new ConfigError(root.range?.[0] ?? 0, '"version" is required and must be 1');

    return {
      config: { version: 1, criticality, ignore, tests, surfaces },
      sha256,
      diagnostics: warnings.sort((a, b) => compareStrings(a.message, b.message)),
    };
  } catch (error) {
    if (error instanceof ConfigError) return invalid(error.offset, error.message);
    throw error;
  }
}

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`, 's');
  globCache.set(pattern, re);
  return re;
}

/** Deterministic glob: `**` crosses `/`, `*` and `?` do not. */
export function matchesGlob(candidate: string, pattern: string): boolean {
  return globToRegExp(pattern).test(candidate);
}

const isGlob = (pattern: string): boolean => /[*?]/.test(pattern);

/** Exact id match beats globs; among globs the longest pattern wins, ties by compareStrings. */
export function criticalityFor(config: GraphentraConfig, surfaceId: string): CriticalityLevel | undefined {
  const exact = config.criticality.find(entry => entry.pattern === surfaceId);
  if (exact) return exact.level;
  const globs = config.criticality
    .filter(entry => isGlob(entry.pattern) && matchesGlob(surfaceId, entry.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length || compareStrings(a.pattern, b.pattern));
  return globs[0]?.level;
}
