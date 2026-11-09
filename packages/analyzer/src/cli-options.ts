import { ENGINE_PROFILES, type ComparisonOptions, type EngineProfile } from './contracts';
import { GraphentraError } from './errors';
export interface CliOptions {
  target: string;
  base?: string;
  head?: string;
  report?: string;
  output?: string;
  workingTree: boolean;
  help?: boolean;
  version?: boolean;
  generateContext?: boolean;
  refreshContext?: boolean;
  /** Reporting only: "files" (default) summarizes files; "functions" describes every function. */
  contextGranularity?: 'files' | 'functions';
  /** Reporting only: let the report model read code at the analyzed revision before writing. */
  lookup?: boolean;
  engine?: EngineProfile;
  maxAffectedEntities?: number;
  maxDepth?: number;
  hubThreshold?: number;
  /** Evidence schema to emit: '2.1' (default) or '3.0' (extended engine only). */
  evidenceSchema?: '2.1' | '3.0';
}

const valueOptions = new Set(['target', 'base', 'head', 'report', 'output', 'engine', 'max-affected-entities', 'max-affected', 'max-depth', 'hub-threshold', 'context-granularity', 'schema']);
const flagOptions = new Set(['working-tree', 'help', 'version']);

export function parseCliOptions(args: string[], configuration: { reporting?: boolean } = {}): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let positionalTarget: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const argument = raw === '-h' ? '--help' : raw === '-v' ? '--version' : raw;
    if (argument.startsWith('-') && !argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);

    if (!argument.startsWith('--')) {
      if (positionalTarget) {
        throw new Error(`Unexpected positional argument: ${argument}`);
      }
      positionalTarget = argument;
      continue;
    }

    const separator = argument.indexOf('=');
    const rawName = argument.slice(2, separator === -1 ? undefined : separator);
    const name = rawName === 'max-affected' ? 'max-affected-entities' : rawName;

    if ((name === 'report' || name === 'context-granularity') && !configuration.reporting) {
      throw new Error(`--${name} is a QA reporting option. Use npm run report.`);
    }
    if (flagOptions.has(name) || (configuration.reporting && (name === 'generate-context' || name === 'refresh-context' || name === 'lookup'))) {
      if (separator !== -1) {
        throw new Error(`Option --${name} does not take a value.`);
      }
      if (flags.has(name)) {
        throw new Error(`Option --${name} may only be provided once.`);
      }
      flags.add(name);
      continue;
    }

    if (!valueOptions.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }

    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value?.trim() || (separator === -1 && value.startsWith('-'))) {
      throw new Error(`Option --${name} requires a value.`);
    }
    if (values.has(name)) {
      throw new Error(`Option --${name} may only be provided once.`);
    }

    if (name === 'engine' && !ENGINE_PROFILES.includes(value as EngineProfile)) {
      throw new GraphentraError(`Unknown engine "${value}". Expected one of: ${ENGINE_PROFILES.join(', ')}.`, 'INVALID_OPTIONS');
    }
    if ((name === 'max-depth' || name === 'hub-threshold') && !/^[1-9]\d*$/.test(value)) {
      throw new GraphentraError(`Option --${name} must be a positive integer, got "${value}".`, 'INVALID_OPTIONS');
    }
    if (name === 'context-granularity' && value !== 'files' && value !== 'functions') {
      throw new GraphentraError(`Option --context-granularity must be "files" or "functions", got "${value}".`, 'INVALID_OPTIONS');
    }
    if (name === 'schema' && value !== '2.1' && value !== '3.0') {
      throw new GraphentraError(`Option --schema must be "2.1" or "3.0", got "${value}".`, 'INVALID_OPTIONS');
    }
    if (name === 'max-affected-entities' && !/^[1-9]\d*$/.test(value)) {
      throw new GraphentraError(`Option --max-affected-entities must be a positive integer, got "${value}".`, 'INVALID_OPTIONS');
    }

    values.set(name, value);
  }

  if (positionalTarget && values.has('target')) {
    throw new Error('Provide the repository using either --target or a positional path, not both.');
  }

  if (flags.has('help') || flags.has('version')) return { target: '', workingTree: false,
    ...(flags.has('help') ? { help: true } : { version: true }) };
  const target = values.get('target') ?? positionalTarget;
  if (!target?.trim()) {
    throw new Error('Repository path is required.');
  }

  const base = values.get('base');
  const head = values.get('head');
  const workingTree = flags.has('working-tree');
  if (workingTree && head) {
    throw new Error('Option --working-tree cannot be used with --head.');
  }
  if (!workingTree && ((base && !head) || (!base && head))) {
    throw new Error('Options --base and --head must be provided together.');
  }

  const result: CliOptions = {
    target,
    base,
    head,
    report: values.get('report'),
    workingTree,
  };

  const output = values.get('output');
  if (output !== undefined) {
    result.output = output;
  }

  const engine = values.get('engine');
  if (engine !== undefined) result.engine = engine as EngineProfile;
  const maxAffected = values.get('max-affected-entities');
  if (maxAffected !== undefined) result.maxAffectedEntities = Number(maxAffected);
  const maxDepth = values.get('max-depth');
  if (maxDepth !== undefined) result.maxDepth = Number(maxDepth);
  const hubThreshold = values.get('hub-threshold');
  if (hubThreshold !== undefined) result.hubThreshold = Number(hubThreshold);
  const schema = values.get('schema');
  if (schema !== undefined) result.evidenceSchema = schema as CliOptions['evidenceSchema'];

  if (flags.has('generate-context')) result.generateContext = true;
  if (flags.has('refresh-context')) result.refreshContext = true;
  if (flags.has('lookup')) result.lookup = true;
  const granularity = values.get('context-granularity');
  if (granularity !== undefined) result.contextGranularity = granularity as CliOptions['contextGranularity'];
  return result;
}

export function resolveCliComparison(options: Pick<CliOptions, 'base' | 'head' | 'workingTree'>,
  environment: { BASE_SHA?: string; HEAD_SHA?: string }): ComparisonOptions {
  if (options.workingTree) return { mode: 'working-tree', base: options.base ?? 'HEAD' };
  if (options.base !== undefined || options.head !== undefined) {
    if (!options.base?.trim() || !options.head?.trim()) throw new Error('--base and --head must be supplied together.');
    return { mode: 'commit', base: options.base, head: options.head };
  }
  if (environment.BASE_SHA !== undefined || environment.HEAD_SHA !== undefined) {
    if (!environment.BASE_SHA?.trim() || !environment.HEAD_SHA?.trim()) throw new Error('BASE_SHA and HEAD_SHA must be a complete nonblank pair.');
    return { mode: 'commit', base: environment.BASE_SHA.trim(), head: environment.HEAD_SHA.trim() };
  }
  return { mode: 'commit', base: 'HEAD~1', head: 'HEAD' };
}
