# Business-First Agent Harness

This project uses `.agent/` as the business context layer for coding agents.

## Required workflow

1. Identify the business intent.
2. Identify affected business entities.
3. Read relevant relationships, rules, states and workflows.
4. Read the relevant impact map.
5. Locate technical implementation.
6. Make the smallest safe change.
7. Validate both technical behavior and business rules.
8. Record new business discoveries as candidates.
9. Promote only verified knowledge into `.agent/business/` with `business-agent promote`.
10. Re-run `business-agent validate` after changing any business knowledge.

## Evidence policy

Never turn a guess into a confirmed business rule. Every rule should have concrete evidence and a confidence level.

## Long-term memory policy

`.agent/memory/` contains temporary/task-level knowledge.
`.agent/business/` contains project-level knowledge that future tasks should trust.
