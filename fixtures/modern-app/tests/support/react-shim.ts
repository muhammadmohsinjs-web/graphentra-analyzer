// Minimal React stand-in for component tests. The fixture has no react dependency, and
// tsx compiles JSX to React.createElement calls. This turns each element into a plain
// object so the rendered output can be asserted on. Import this module before rendering.

export interface El {
  t: unknown;
  p: Record<string, any> | null;
  c: unknown[];
}

const createElement = (t: unknown, p: Record<string, any> | null, ...children: unknown[]): El => ({
  t,
  p,
  c: children.flat(),
});

(globalThis as any).React = { createElement, Fragment: 'Fragment' };
