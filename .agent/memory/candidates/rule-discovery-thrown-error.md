# Candidate: Explicit validation error thrown

Status: candidate

## Entity
Unknown

## Hypothesis
- Review the matched conditions, disabled controls, and thrown validation errors as candidate business rules.

## Evidence
- src\cli-args.ts
- src\cli.ts
- src\commands\config.ts
- src\commands\conflicts.ts
- src\commands\continuous-learning.ts
- src\commands\deprecate.ts
- src\commands\hook.ts
- src\commands\learn.ts
- src\commands\promote.ts
- src\commands\review.ts

## Context
- src\cli-args.ts:95: throw new Error(`Unknown ${label} option: --${key}`);
- src\cli.ts:60: task: 'Usage: business-agent task start|context|predict-impact|checkpoint|test|finish|feedback\n\nRun the Agent task lifecycle and persist structured task knowledge.\n\nFeedback:\n  business-agent task feedback <type> <targetId> [--reason <text>] [--correction <text>]\n\nKnowledge:\n  business-agent knowledge status <targetId>\n  business-agent knowledge verify <targetId> [--reason <text>]\n  business-agent knowledge stale --id <id> [--reason <text>]',
- src\commands\config.ts:17: if (result === undefined) throw new Error(`Unknown config key: ${key}`);
- src\commands\conflicts.ts:17: throw new Error(`Invalid discovery manifest: ${manifestFile}`);
- src\commands\continuous-learning.ts:2: import { loadKnowledgeState, type KnowledgeRecord, type KnowledgeStatus } from '../core/knowledge-state.js';
- src\commands\deprecate.ts:7: if (!ruleId) throw new Error('Usage: business-agent deprecate <rule-id>');
- src\commands\hook.ts:17: throw new Error('Not a git repository: .git not found. Run `git init` or `business-agent init` first.');
- src\commands\learn.ts:20: `Status: candidate`,
- src\commands\promote.ts:68: if (!content.includes('Status: candidate')) return;
- src\commands\review.ts:85: if (content.includes('Status: promoted') || content.includes('Status: rejected')) continue;

## Impact
- Review related UI, API, service, and database code.

## Verification
- Verify against frontend, backend, API and database evidence.
