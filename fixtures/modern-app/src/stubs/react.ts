export type ReactNode = unknown;

export function useState<T>(init: T): [T, (v: T) => void] {
  let value = init;
  return [value, (v: T) => { value = v; }];
}

export function useEffect(fn: () => void, deps?: unknown[]): void {
  void deps;
  fn();
}

export function useMemo<T>(fn: () => T, deps?: unknown[]): T {
  void deps;
  return fn();
}
