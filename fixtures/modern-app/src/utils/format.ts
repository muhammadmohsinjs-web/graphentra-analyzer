// Formatting helpers: arrow, function expression, default export, plain named function.

export const formatPrice = (n: number): string => {
  const rounded = Math.round(n * 100) / 100;
  return '$' + rounded.toFixed(2);
};

export const pad = function (s: string, width: number): string {
  let out = s;
  while (out.length < width) {
    out = ' ' + out;
  }
  return out;
};

export default function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}
