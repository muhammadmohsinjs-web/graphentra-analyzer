function sanitizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

export function checkInventory(sku: string, quantity: number): boolean {
  const cleanSku = sanitizeSku(sku);
  if (!cleanSku || quantity <= 0) {
    return false;
  }
  return quantity <= 100;
}

export function reserveStock(sku: string, quantity: number): boolean {
  const isAvailable = checkInventory(sku, quantity);
  if (!isAvailable) {
    return false;
  }
  return true;
}
