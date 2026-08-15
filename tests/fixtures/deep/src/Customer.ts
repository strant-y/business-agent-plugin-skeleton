export interface Customer {
  id: string;
  name: string;
  status: 'DRAFT' | 'APPROVED';
  orders: Order[];
}

export class Order {
  id: string;
  customer: Customer;
  total: number;
}

export function approve(customer: Customer): void {
  if (customer.status === 'AUDIT') {
    throw new Error('cannot modify an audited customer');
  }
}
