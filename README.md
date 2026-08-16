# business-agent

A minimal Business-First, Project-aware Agent Harness CLI for Node.js + TypeScript.

## What it does

- `init` installs a reusable `.agent/` structure into any repository (`--force` re-applies template files).
- `discover` scans source files and creates initial business entity/rule/relation candidates. Candidate rules are stored under `.agent/memory/candidates/` so they can be verified and promoted; only confirmed knowledge lands in `.agent/business/`. Manual edits to entity files are preserved across runs.
  - `discover --deep` additionally runs pluggable analyzers (SQL foreign keys, API routes, TypeScript AST, Vue SFC, Pinia/Vuex stores, composables and API wrappers, frontend pages/actions, React JSX/Hook patterns, Java, MyBatis XML, cross-end linkage) and rule-conflict detection.

- `context` creates a task-oriented business context package including relevant rules, relationships, conflicts, API routes and impact maps (`--json` for machine-readable output).
- `review` interactively accepts, rejects, or skips candidate rules; use `--non-interactive --accept medium --reject low` for scripted review.
- `evolve` stores candidate knowledge for later verification and promotion.
- `promote` validates a verified candidate against the schemas, promotes it into confirmed knowledge under `.agent/business/` (with an impact map), marks the candidate file as promoted, and warns when a candidate is promoted a second time.
- `validate` checks the discovery manifest and the confirmed knowledge files against the JSON schemas in `schemas/`.
- `review` supports interactive or scripted candidate review; `--json` emits a machine-readable summary and rejected candidates move to `.agent/memory/candidates/rejected/`.
- `config get/set` reads or updates `.agent/business-agent.json`.
- `conflicts` recalculates rule conflicts and suggestions; `deprecate` marks a confirmed rule as deprecated and refreshes the knowledge index.
- `states` writes Mermaid state diagrams; `workflow` creates a manual workflow template.
- `learn` records a business discovery as a reviewable candidate; `impact` maps changed files to affected entities, rules, relationships, and APIs — first by walking the relation graph from the changed module (view → store → entity → rule/API) in both directions, falling back to file-name evidence when no graph node matches.
- `capture` is the task-closing step: it writes a task-history record (changed files + the code-level impact chain) and, with `--learn`, records a verified business fact as a reviewable candidate. `hook install` adds a `post-commit` git hook that runs `capture --since last-commit --quiet` automatically after every commit, so knowledge keeps accumulating while you work.
- `task` provides the Agent task lifecycle: `start`, `context`, `predict-impact`, `checkpoint`, `test`, and `finish`. Sessions are stored as structured JSON under `.agent/memory/sessions/`; finishing with `--learn` also creates a reviewable candidate.

The default discovery engine is intentionally conservative. Deep analysis is opt-in via `--deep` or the `analyzers` config.

## Library usage

Everything the CLI does is also available programmatically:

```ts
import { discover, scanProject, runAnalyzers } from 'business-agent';

const manifest = await discover(process.cwd(), {
  analyzers: ['sql', 'api', 'ast'],
  onWarning: (message) => console.warn(message),
});
```

See `src/index.ts` for the full public surface.

## Quick start

```bash
npm install
npm run build
npm link

cd your-project
business-agent init
business-agent discover --deep
business-agent context Plan
business-agent evolve "审核中的方案不能修改核心险种"
business-agent promote "审核中的方案不能修改核心险种" --entity Plan
business-agent validate
```

## CLI

```text
business-agent <command> [options]

Commands:
  init                  Initialize .agent/ (--force re-applies templates)
  discover              Scan project and create initial business knowledge
  context <subject>     Build active business context
  evolve [candidate]    Create a candidate knowledge item
  promote <candidate>   Promote verified candidate into confirmed knowledge
  validate              Validate the discovery manifest against schemas
  review                Review candidate rules interactively or in batch
  config                Read or update project configuration
  conflicts             Detect rule conflicts and suggestions
  deprecate             Deprecate a confirmed rule
  states                Extract state machines
  workflow              Create a workflow template
  learn                 Record a business discovery candidate
  impact                Build a change impact report
  capture               Record a task-closing summary (task-history + optional candidate)
  hook                  Install/remove the post-commit auto-capture hook
  task                  Run the Agent task lifecycle and persist task knowledge

Global options:
  --help, -h            Show help for a command or this overview
  --version, -v         Print the version
  --dry-run             Do not write any files
  --deep                Run deep analyzers (discover)
  --json                Emit machine-readable output
```

Example: `business-agent discover --deep --json` emits the full manifest without writing files.

Task lifecycle example:

```bash
business-agent task start "修改订单审核流程"
business-agent task context
business-agent task predict-impact --files src/stores/orderStore.ts,src/views/OrderEdit.vue
# 修改代码后
business-agent task checkpoint
business-agent task test --command "npm test" --passed true --summary "All tests passed"
business-agent task finish "完成订单审核流程" --learn "审核中的订单不能修改"
```

Task sessions persist in `.agent/memory/sessions/`, with the active session pointer in `.agent/memory/active-session.json`. Use `--json` for Agent integration and `--dry-run` to inspect without writing.

## Configuration

`init` creates `.agent/business-agent.json`. All keys are optional and merge over the defaults
(array values replace the defaults entirely):

| Key                 | Default                                                          | Meaning                                                                                                                              |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ignoreDirs`        | `node_modules, .git, dist, build, ...`                           | Directories skipped during scanning                                                                                                  |
| `allowedExt`        | `.ts, .tsx, .vue, .java, .sql, .xml, .js, .jsx`                  | File extensions scanned                                                                                                              |
| `preferredEntities` | `[]`                                                             | Terms treated as medium-confidence entities (word-boundary matched)                                                                  |
| `maxFileBytes`      | `1048576`                                                        | Files larger than this are skipped                                                                                                   |
| `maxEntities`       | `100`                                                            | Maximum entities reported                                                                                                            |
| `maxSampleFiles`    | `40`                                                             | Maximum files read for pattern analysis                                                                                              |
| `maxSamplesPerExt`  | `20`                                                             | Per-file-extension sample cap (balances front/back-end in monorepos)                                                                 |
| `maxSampleChars`    | `8000`                                                           | Per-file sample size                                                                                                                 |
| `relationWindow`    | `150`                                                            | Max distance for relation hints                                                                                                      |
| `analyzers`         | `[]`                                                             | Deep analyzers to run on `discover` (`sql`, `api`, `ast`, `vue`, `stores`, `frontend`, `java`, `xml`, `linkage`, `llm`, `llm-rules`) |
| `llm`               | `{ provider: 'openai-compatible', apiKeyEnv: 'OPENAI_API_KEY' }` | Optional LLM enrichment; `model`/`baseUrl` default to `gpt-4o-mini` / `https://api.openai.com/v1` when empty                         |
| `autoPromote`       | `never`                                                          | Automatic candidate promotion threshold: `never`, `high`, or `medium`                                                                |

## Deep analysis

`discover --deep` (or `analyzers` in config) runs:

P1 frontend models are available by adding `"frontend"` to `analyzers`; the generated manifest includes `pages` and `actions` for context and impact analysis.

- **sql** — extracts `CREATE TABLE` as entities and `REFERENCES`/`JOIN` as relations (shared SQL parser in `src/core/analyzers/parse.ts`).
- **api** — extracts Express/Nest/Vue-router/Spring route registrations. Frontend router paths are tagged `kind: "frontend"` and never participate in cross-end linkage.
- **ast** — TypeScript interface/class attributes and typed references (requires `typescript` at runtime; skipped with a warning otherwise).
- **vue** — Vue SFC analyzer: parses `<script lang="ts">` via the shared TS AST logic, maps `defineProps`/`defineEmits` to entity attributes, `.vue` component imports to relations, and `<template>` `v-if` / `:disabled` to candidate rules.
- **stores** — frontend business-logic analyzer: Pinia (`defineStore`) and Vuex (`createStore`) stores, `useXxx` composables and API wrapper modules become typed technical entities; state fields / `ref<T>` declarations become attributes; status assignments, `setStatus` calls, status guards and thrown validation errors become candidate rules; `Promise<T>` response types link API wrappers to their entities, and referenced entities/composables become relations.
- **frontend** — frontend business-flow analyzer for Vue, React JSX and TypeScript/JavaScript modules: classifies pages/components, detects page routes, Store and API usage, user actions, state reads/writes, permissions, `v-if`/`disabled` conditions and form validation signals. It writes structured `pages` and `actions` to the discovery manifest and connects page -> action -> Store/API relationships.
- **java** — JPA `@Entity`/`@Table` entities + `@Column` attributes, `@ManyToOne`/`@OneToMany` relations with cardinality, service-level rules from thrown exceptions and status branches, and combined `@RestController` + `@RequestMapping` routes.
- **xml** — MyBatis mapper analysis: `<resultMap>` entities/fields, `<association>` relations, and SQL inside `<select>`/`<insert>`/`<update>`/`<delete>` via the shared SQL parser.
- **linkage** — cross-end chain: matches `axios`/`fetch` calls in frontend views (including template-literal paths like `` `/api/orders/${id}?x=1` ``) to extracted backend API routes, then to their backend entity, exposing the view→API→entity→table→rule chain as relations shown by `context <subject>`.
- **conflicts** — flags rules on the same entity with opposing constraints (e.g. `cannot` vs `allow`).

Analyzers implement the `Analyzer` interface in `src/core/analyzer.ts`, so new ones (Java, XML mappers, LLM interpretation) plug in without touching the discovery pipeline. Analyzers run in dependency phases: entity producers (`sql`/`ast`/`vue`/`stores`/`java`/`xml`) execute concurrently first, the dependent analyzers (`api`/`llm`/`llm-rules`) run next against the merged entities, and `linkage` runs last once all API routes are known. Results merge in phase order, so output is deterministic regardless of timing; a failing analyzer is reported as a warning instead of aborting discovery.

## LLM enrichment (optional)

Configure `llm` in `.agent/business-agent.json` and add `"llm"` or `"llm-rules"` to `analyzers`. The `llm` analyzer sends only entity names and attribute names, then rewrites descriptions through an OpenAI-compatible `POST /chat/completions` endpoint. The `llm-rules` analyzer sends source snippets only when `llm.allowSourceUpload` is explicitly `true`; snippets are passed through `redactSecrets` before upload and become low-confidence candidates flagged for manual verification. Set `provider` to `ollama`, `model` to `qwen2.5-coder`, and `apiKeyEnv` to `none` for a local Ollama endpoint at `http://localhost:11434/v1`. Requests time out after 30 seconds and transient failures (429/5xx/timeouts/network errors) are retried twice with exponential backoff.

Use `business-agent config get` or `business-agent config set llm.provider ollama` to edit configuration without hand-editing JSON.

For an agent workflow, run `business-agent context <subject>` before editing, `business-agent impact` after changing files, and `business-agent capture "task summary" --learn "<verified fact>" --entity <name>` at the end of the task — or install the `post-commit` hook once with `business-agent hook install` so every commit is captured automatically.

## Knowledge model

| Dir                           | Contents                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `business/entities/`          | Entity markdown (manual edits are preserved across `discover` runs)                |
| `business/rules/`             | Confirmed rule JSON + markdown + impact map                                        |
| `business/relationships/`     | Confirmed relationship JSON + markdown + impact map                                |
| `business/impact/`            | Impact maps                                                                        |
| `business/states/`            | Generated Mermaid state diagrams                                                   |
| `business/workflows/`         | Manually maintained workflow templates                                             |
| `memory/candidates/`          | Unverified candidate knowledge                                                     |
| `memory/candidates/rejected/` | Rejected candidate records                                                         |
| `memory/task-history/`        | Task-closing records written by `capture` (changed files + impact chain + summary) |

## Architecture

```text
CLI
 ├── init
 ├── discover (--deep)
 ├── context
 ├── evolve
 ├── promote
 └── validate

Core
 ├── scanner
 ├── discovery
  ├── analyzer (+ sql / api / ast / vue / java / xml / linkage / llm / llm-rules / states)
 ├── conflicts
 ├── evidence
 ├── knowledge (persistence + index)
   ├── validate
  ├── review / config / conflicts / deprecate / states / workflow
 (JSON Schema)
 └── typed knowledge models

Project output
 └── .agent/
     ├── HARNESS.md
     ├── business-agent.json
     ├── business/
     └── memory/
```

## Development

```bash
npm run check         # typecheck only
npm run lint          # eslint
npm run format:check  # prettier check
npm run format        # apply prettier formatting
npm test              # run the vitest suite
npm run build         # compile to dist/
npm run release:verify # publish gate: check + lint + format + test + build
```

## Release

```bash
npm version patch
git push --follow-tags
```

- `npm version patch|minor|major` updates `package.json`, creates a Git tag like `v0.1.1`, and is the supported way to cut releases.
- Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which reruns the full quality gate and publishes to npm only when the tag matches `package.json`.
- Configure `NPM_TOKEN` in GitHub repository secrets before the first release.

## Next implementation stage

详细方案、里程碑与取舍见 [ROADMAP.md](./ROADMAP.md)。概要：

1. 发布到 npm（改名为 `business-agent-cli`，含发布 CI）。
2. 评审闭环：`review` 命令、评审状态持久化、`autoPromote` 旋钮。
3. LLM 本地模型支持（Ollama）与上传隐私开关。
4. SQL 子查询 / 多 JOIN 关系提取、冲突解决建议、状态机与工作流建模。
