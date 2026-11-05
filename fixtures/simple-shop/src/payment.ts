export const chargeCard = (amountInCents: number): string => `$${(amountInCents / 100).toFixed(2)}`;
