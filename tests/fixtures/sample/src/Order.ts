export class Order {
  id: string;
  status: 'DRAFT' | 'APPROVED';

  constructor(id: string, status: 'DRAFT' | 'APPROVED') {
    this.id = id;
    this.status = status;
  }

  update(): void {
    // Editors are locked while a draft is being reviewed.
    disabled = true;
  }
}
