# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to semantic versioning.

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
- Upgraded vitest to 4.1.11, which fixes the intermittent "tests pass but the process never exits" hang on Windows (single-file runs no longer hang; full-suite hangs are a vitest/Windows teardown race, unrelated to the plugin code — every test file exits cleanly on its own).

## [0.1.0] - 2026-08

### Added

- Initial skeleton: discovery analyzers (sql/api/ast/vue/java/xml/stores/frontend/linkage/llm), knowledge lifecycle (candidate → review → promote → conflicts → deprecate), impact analysis, task sessions, audit, retrieval.
