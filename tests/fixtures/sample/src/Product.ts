export interface Product {
  id: string;
  name: string;
  status: string;
  orders: Order[];
}

export function review(product: Product): void {
  if (product.status === 'AUDIT') {
    throw new Error('cannot modify core coverage while under audit');
  }
}
