# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to semantic versioning.

## [Unreleased]

### Added

- Candidate status is now a single source of truth (`src/core/candidate-status.ts`): review, audit, retrieval and index all read status from YAML front matter first (candidateId/status/confidence/reviewedAt/targetRuleId/reason), then legacy English `Status:` lines and Chinese `- 状态:` lines, and default unrecognized or missing markers to pending — no more candidates silently skipped because they used a different spelling.
- Every written candidate carries stable front matter metadata (`candidateId` + `status`), and promote/reject/cover rewrite both the front matter and the legacy `Status:` line so older tooling keeps working.
- Review-state v2: decisions are keyed by the stable candidate id (`candidateId:<id>`) in addition to the legacy `{entity,name}` key, and record the canonical status, target rule id, reason and reviewer. Pre-v2 state files remain readable.
- Single-candidate review commands: `review <candidateId> --reject [--reason …]`, `review <candidateId> --covered-by <ruleId> [--reason …]`, and `promote <candidateId> --into <ruleId>` to merge a candidate into an existing rule. These close the "candidate merged into / superseded by an existing rule" review outcome without creating duplicates.
- `audit` now reconciles three sources (manifest candidates, candidate files, review-state decisions) and reports each count plus concrete reconcile actions (`--json` exposes the numbers), instead of a single boolean "noise" line.
- `validate` gained cross-file consistency checks: every rule JSON must have its Markdown and impact map, ids must be unique, evidence must be non-empty, INDEX.md links must resolve, and candidate status markers must be recognized. Each rule is reported individually in `validate --json`.
- `index rebuild` verifies INDEX.md link integrity after rebuilding and warns about broken links.

### Fixed

- Promoting a candidate whose name contains no ASCII (e.g. a Chinese title) no longer collapses to the shared `rule.promoted-rule` id that silently overwrote earlier promotions. Rule ids fall back to the candidate file slug, then to a deterministic hash of the name, so two Chinese-title promotions always produce distinct, predictable ids.
- Promote refuses to overwrite an existing rule with a different name/entity: it fails fast and asks for `--id <new-id>` or `--into <existing-id>` instead of clobbering confirmed knowledge.
- Retrieval indexes exclude resolved candidates: `promoted`/`covered`/`rejected` candidates (by file status or review-state) no longer surface in default `retrieve` results or outrank confirmed rules; `needs-verification` stays in the low-confidence partition as intended.
- `candidateId` is preserved across review transitions; front matter updates rewrite the whole block without duplicating keys.

## [0.2.0] - 2026-08-31

- Review decisions now survive entity alias normalization in discovery: `applyReviewState` ran before `resolveCanonicalNameFromIndex` renamed candidate entity names, so rejected/accepted decisions keyed on canonical manifest entities never matched during filtering and candidates reappeared as pending noise on every re-discover (observed as 61 low-confidence rules stuck "pending" in cip-views despite being rejected). Review decisions are now re-applied to non-confirmed rules after normalization.
- `hook install` and the audit hook check now resolve the git repository root by walking up parent directories instead of assuming `<projectRoot>/.git` exists, so projects that live in a subdirectory of their repo (e.g. cip-views inside the cip repo) can install and detect the post-commit hook. The generated hook cds back to the project root and invokes the plugin CLI by absolute path, since business projects typically have no global `business-agent` command on PATH.

## [0.2.0] - 2026-08-31

### Changed

- Package renamed to `business-agent-cli` (the npm name `business-agent` is taken by an unrelated package); the `business-agent` binary/command is unchanged, so existing workflows need no migration.
- Entity descriptions: auto-discovered entities now carry an evidence-bearing description (`Auto-discovered candidate X; evidence: …`) instead of the bare template; human/LLM-authored descriptions always win on merge.
- Entity descriptions: glossary terms (e.g. Chinese business vocabulary) are copied onto entity tags and appended to skeleton descriptions as `; business aliases: …` (idempotent across discover runs).

### Added

- `states` analyzer joins the `--deep` set, so `discover --deep` populates `entity.states` by default (lifecycle back-link G1.5).
- Context output resolves state-machine entity names through the alias index, so renamed entities keep their mermaid diagram.
- Post-commit capture writes a knowledge-refresh log (`.agent/memory/hook-refresh.log`, JSONL, capped at 200 lines) and skips incremental re-discover when the run exceeds a 10s budget.
- Relationship model: typed `owns / aggregates / references / calls / renders / maps-to` with subtypes and provenance, plus in-memory migration of legacy values.
- Field-level impact propagation (`fieldIndex`), rule↔test coverage (`coveringTests` + `## Test Coverage`), rule-violation detection (`## Rule Violations`), and mermaid impact/context graphs.
- OpenAPI contract reconciliation analyzer; Go and Python entity analyzers; configurable `impact.maxDepth` (default 6); cross-repo `linkage.externalApis`; semantic (precondition-level) rule-conflict hints.

### Fixed

- Graph node identity is now based on module path (`moduleNodeId`) instead of PascalCase file names, so renames and mixed naming conventions no longer break impact chains (legacy manifests fall back with a warning).
- Manifest consumers (impact/context/retrieval/states/task) now shape-check the discovery manifest at runtime instead of trusting `JSON.parse` blindly: corrupted files degrade to a warning instead of a crash or a garbage report.
- Co-occurrence relations now record `file:line` evidence (aligned with rule evidence), so they can be reviewed without re-searching the file.
- Knowledge must be code-first: evidence scoring now treats documents/notes as reference material, not ground truth — text-only evidence (e.g. docs/*.md, meeting notes) never scores above low, and only code-backed references (ts/vue/java/sql/...) reach medium/high. Docs can move, be deleted, or drift from the implementation; code keeps knowledge verifiable (learned from a real audit where deleted design docs broke rule evidence chains).
- Upgraded vitest to 4.1.11, which fixes the intermittent "tests pass but the process never exits" hang on Windows (single-file runs no longer hang; full-suite hangs are a vitest/Windows teardown race, unrelated to the plugin code — every test file exits cleanly on its own).

## [0.1.0] - 2026-08

### Added

- Initial skeleton: discovery analyzers (sql/api/ast/vue/java/xml/stores/frontend/linkage/llm), knowledge lifecycle (candidate → review → promote → conflicts → deprecate), impact analysis, task sessions, audit, retrieval.
