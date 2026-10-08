const clamp = (n: number) => (n < 0 ? 0 : n);

export const inventory = {
  stock: new Map<string, number>(),
  reserve(sku: string, qty: number) {
    const left = clamp((this.stock.get(sku) ?? 0) - qty);
    this.stock.set(sku, left);
    return left;
  },
  release: (sku: string) => {
    inventory.stock.delete(sku);
    return inventory.reserve(sku, 0);
  },
};

export const checkStock = (sku: string) => inventory.stock.get(sku) ?? 0;
