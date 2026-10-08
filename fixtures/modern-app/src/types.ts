export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export interface Order {
  id: string;
  items: Item[];
}
