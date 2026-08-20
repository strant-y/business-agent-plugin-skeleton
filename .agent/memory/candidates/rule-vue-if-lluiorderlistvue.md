# Candidate: Conditional rendering constraints (v-if)

Status: candidate

## Entity
OrderList

## Hypothesis
- Elements are rendered only when: selected.status ===.

## Evidence
- tests\fixtures\full\ui\OrderList.vue

## Context
- tests\fixtures\full\ui\OrderList.vue: template context: " /> <button :disabled="selected.status === 'AUDIT'">Edit</button> <p v-if="selected.status === 'DRAFT'">Draft order</p> </div>

## Impact
- TBD

## Verification
- Verify against frontend, backend, API and database evidence.
