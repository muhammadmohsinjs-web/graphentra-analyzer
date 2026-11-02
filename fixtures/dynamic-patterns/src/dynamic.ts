import { helper } from './core';
import type { Runner } from './types';

declare const registry: Record<string, (input: string) => string>;

export function runEval(code: string): unknown {
  helper(code);
  return eval(code);
}

export function loadPlugin(name: string): unknown {
  helper(name);
  return require(name);
}

export function loadLazy(name: string): Promise<unknown> {
  helper(name);
  return import(name);
}

export function dispatch(key: string): string {
  helper(key);
  return registry[key](key);
}

export function callAny(handler: any): unknown {
  helper('any');
  return handler('x');
}

export function runViaInterface(runner: Runner): string {
  return runner.run(helper('interface'));
}

export function resolvable(): string {
  return helper('static');
}
