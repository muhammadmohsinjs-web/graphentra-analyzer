export interface CliOptions {
  target: string;
  base?: string;
  head?: string;
  report?: string;
  workingTree: boolean;
}

const valueOptions = new Set(['target', 'base', 'head', 'report']);
const flagOptions = new Set(['working-tree']);

export function parseCliOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let positionalTarget: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;

    if (!argument.startsWith('--')) {
      if (positionalTarget) {
        throw new Error(`Unexpected positional argument: ${argument}`);
      }
      positionalTarget = argument;
      continue;
    }

    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator === -1 ? undefined : separator);

    if (flagOptions.has(name)) {
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
    if (!value || (separator === -1 && value.startsWith('--'))) {
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

  const target = values.get('target') ?? positionalTarget;
  if (!target) {
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

  return {
    target,
    base,
    head,
    report: values.get('report'),
    workingTree,
  };
}
