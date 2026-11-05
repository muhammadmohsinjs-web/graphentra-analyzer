const PRICES_IN_CENTS: Record<string, number> = { 'TEA-1': 500 };

export const getPrice = (code: string): number => PRICES_IN_CENTS[code] ?? 0;
