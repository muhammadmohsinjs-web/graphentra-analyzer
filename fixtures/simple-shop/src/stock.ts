const STOCK: Record<string, number> = { 'TEA-1': 10 };

export const stockOf = (code: string): number => STOCK[code] ?? 0;
