import type { ComparisonOptions } from './contracts';
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
}

const valueOptions = new Set(['target', 'base', 'head', 'report', 'output']);
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
    const name = argument.slice(2, separator === -1 ? undefined : separator);

    if (name === 'report' && !configuration.reporting) throw new Error('--report is a QA reporting option. Use npm run report.');
    if (flagOptions.has(name) || (configuration.reporting && name === 'generate-context')) {
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

  if (flags.has('generate-context')) result.generateContext = true;
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
