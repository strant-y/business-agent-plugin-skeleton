# Order

> Status: high

## Description
Discovered from AST in tests\fixtures\full\ui\OrderList.vue.

## Attributes
- id: string
- status: 'DRAFT' | 'APPROVED'
- total: BigDecimal
- customer: Customer
- items: List<OrderItem>

## Evidence
- tests\fixtures\full\java\Order.java
- tests\fixtures\full\java\OrderController.java
- tests\fixtures\full\java\OrderService.java
- tests\fixtures\full\mapper\OrderMapper.xml
- tests\fixtures\full\ui\OrderList.vue
- tests\fixtures\linkage\composables\useOrderData.ts
- tests\fixtures\linkage\ui\OrderList.vue
- tests\fixtures\sample\src\Order.ts
