# Candidate: Disabled control constraints (:disabled)

Status: candidate

## Entity
OrderList

## Hypothesis
- Controls are disabled when: selected.status ===.
- Controls are disabled when: order.status ===.

## Evidence
- tests\fixtures\full\ui\OrderList.vue
- tests\fixtures\linkage\ui\OrderList.vue

## Context
- tests\fixtures\full\ui\OrderList.vue: template context: <div> <OrderCard :order="selected" /> <button :disabled="selected.status === 'AUDIT'">Edit</button> <p v-if="selected.status === 'DRAFT'">Draft order</p>
- tests\fixtures\linkage\ui\OrderList.vue: template context: <div> <button :disabled="order.status === 'AUDIT'">Edit</button> </div>

## Impact
- TBD

## Verification
- Verify against frontend, backend, API and database evidence.
