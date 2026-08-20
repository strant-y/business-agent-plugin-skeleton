# Candidate: Disabled control / conditional edit discovered

Status: candidate

## Entity
Unknown

## Hypothesis
- Review the matched conditions, disabled controls, and thrown validation errors as candidate business rules.

## Evidence
- tests\fixtures\full\ui\OrderList.vue
- tests\fixtures\linkage\ui\OrderList.vue

## Context
- tests\fixtures\full\ui\OrderList.vue:4: <button :disabled="selected.status === 'AUDIT'">Edit</button>
- tests\fixtures\linkage\ui\OrderList.vue:3: <button :disabled="order.status === 'AUDIT'">Edit</button>

## Impact
- Review related UI, API, service, and database code.

## Verification
- Verify against frontend, backend, API and database evidence.
