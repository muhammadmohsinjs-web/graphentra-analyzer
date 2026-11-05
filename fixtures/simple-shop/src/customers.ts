const CUSTOMERS: Record<string, { first: string; last: string }> = {
  c1: { first: 'Ada', last: 'Lovelace' },
};

export const getCustomerName = (id: string): string => {
  const customer = CUSTOMERS[id];
  return `${customer.first} ${customer.last}`;
};
