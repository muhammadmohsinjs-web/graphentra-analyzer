export function roundToTwo(num: number): number {
  return Math.round(num * 100) / 100;
}

export function formatCurrency(amount: number): string {
  const rounded = roundToTwo(amount);
  return `$${rounded.toFixed(2)}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateId(): string {
  return `id_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}
