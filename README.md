# business-agent

A minimal Business-First, Project-aware Agent Harness CLI for Node.js + TypeScript.

## What it does

- `init` installs a reusable `.agent/` structure into any repository (`--force` re-applies template files).
- `discover` scans source files and creates initial business entity/rule/relation candidates. Candidate rules are stored under `.agent/memory/candidates/` so they can be verified and promoted; only confirmed knowledge lands in `.agent/business/`. Manual edits to entity files are preserved across runs.
- `discover --deep` additionally runs pluggable analyzers (SQL foreign keys, API routes, TypeScript AST, Vue SFC, Java, MyBatis XML, cross-end linkage) and rule-conflict detection.
- `context` creates a task-oriented business context package including relevant rules, relationships, conflicts, API routes and impact maps (`--json` for machine-readable output).
- `evolve` stores candidate knowledge for later verification and promotion.
- `promote` validates a verified candidate against the schemas, promotes it into confirmed knowledge under `.agent/business/` (with an impact map), marks the candidate file as promoted, and warns when a candidate is promoted a second time.
- `validate` checks the discovery manifest and the confirmed knowledge files against the JSON schemas in `schemas/`.

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

Global options:
  --help, -h            Show help for a command or this overview
  --version, -v         Print the version
  --dry-run             Do not write any files
  --deep                Run deep analyzers (discover)
  --json                Emit machine-readable output
```

Example: `business-agent discover --deep --json` emits the full manifest without writing files.

## Configuration

`init` creates `.agent/business-agent.json`. All keys are optional and merge over the defaults
(array values replace the defaults entirely):

| Key                 | Default                                                          | Meaning                                                                                                        |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ignoreDirs`        | `node_modules, .git, dist, build, ...`                           | Directories skipped during scanning                                                                            |
| `allowedExt`        | `.ts, .tsx, .vue, .java, .sql, .xml, .js, .jsx`                  | File extensions scanned                                                                                        |
| `preferredEntities` | `[]`                                                             | Terms treated as medium-confidence entities (word-boundary matched)                                            |
| `maxFileBytes`      | `1048576`                                                        | Files larger than this are skipped                                                                             |
| `maxEntities`       | `100`                                                            | Maximum entities reported                                                                                      |
| `maxSampleFiles`    | `40`                                                             | Maximum files read for pattern analysis                                                                        |
| `maxSamplesPerExt`  | `20`                                                             | Per-file-extension sample cap (balances front/back-end in monorepos)                                           |
| `maxSampleChars`    | `8000`                                                           | Per-file sample size                                                                                           |
| `relationWindow`    | `150`                                                            | Max distance for relation hints                                                                                |
| `analyzers`         | `[]`                                                             | Deep analyzers to run on `discover` (`sql`, `api`, `ast`, `vue`, `java`, `xml`, `linkage`, `llm`, `llm-rules`) |
| `llm`               | `{ provider: 'openai-compatible', apiKeyEnv: 'OPENAI_API_KEY' }` | Optional LLM enrichment; `model`/`baseUrl` default to `gpt-4o-mini` / `https://api.openai.com/v1` when empty   |

## Deep analysis

`discover --deep` (or `analyzers` in config) runs:

- **sql** — extracts `CREATE TABLE` as entities and `REFERENCES`/`JOIN` as relations (shared SQL parser in `src/core/analyzers/parse.ts`).
- **api** — extracts Express/Nest/Vue-router/Spring route registrations. Frontend router paths are tagged `kind: "frontend"` and never participate in cross-end linkage.
- **ast** — TypeScript interface/class attributes and typed references (requires `typescript` at runtime; skipped with a warning otherwise).
- **vue** — Vue SFC analyzer: parses `<script lang="ts">` via the shared TS AST logic, maps `defineProps`/`defineEmits` to entity attributes, `.vue` component imports to relations, and `<template>` `v-if` / `:disabled` to candidate rules.
- **java** — JPA `@Entity`/`@Table` entities + `@Column` attributes, `@ManyToOne`/`@OneToMany` relations with cardinality, service-level rules from thrown exceptions and status branches, and combined `@RestController` + `@RequestMapping` routes.
- **xml** — MyBatis mapper analysis: `<resultMap>` entities/fields, `<association>` relations, and SQL inside `<select>`/`<insert>`/`<update>`/`<delete>` via the shared SQL parser.
- **linkage** — cross-end chain: matches `axios`/`fetch` calls in frontend views (including template-literal paths like `` `/api/orders/${id}?x=1` ``) to extracted backend API routes, then to their backend entity, exposing the view→API→entity→table→rule chain as relations shown by `context <subject>`.
- **conflicts** — flags rules on the same entity with opposing constraints (e.g. `cannot` vs `allow`).

Analyzers implement the `Analyzer` interface in `src/core/analyzer.ts`, so new ones (Java, XML mappers, LLM interpretation) plug in without touching the discovery pipeline. Analyzers run in dependency phases: entity producers (`sql`/`ast`/`vue`/`java`/`xml`) execute concurrently first, the dependent analyzers (`api`/`llm`/`llm-rules`) run next against the merged entities, and `linkage` runs last once all API routes are known. Results merge in phase order, so output is deterministic regardless of timing; a failing analyzer is reported as a warning instead of aborting discovery.

## LLM enrichment (optional)

Configure `llm` in `.agent/business-agent.json`, set the API key environment variable (default `OPENAI_API_KEY`), and add `"llm"` or `"llm-rules"` to `analyzers`. The `llm` analyzer rewrites entity descriptions via an OpenAI-compatible `POST /chat/completions` endpoint. The `llm-rules` analyzer asks the model to extract rules and relationships from arbitrary-language snippets and stores them as low-confidence candidates flagged for manual verification; it prioritizes the snippets most likely to contain business rules (status branches, validation, disabled controls, thrown errors). Both are fully optional and skipped when the key is absent. Requests time out after 30 seconds and transient failures (429/5xx/timeouts/network errors) are retried twice with exponential backoff; note that running either analyzer sends source code snippets to the configured endpoint.

## Knowledge model

| Dir                       | Contents                                                                   |
| ------------------------- | -------------------------------------------------------------------------- |
| `business/entities/`      | Entity markdown (manual edits are preserved across `discover` runs)        |
| `business/rules/`         | Confirmed rule JSON + markdown + impact map                                |
| `business/relationships/` | Confirmed relationship JSON + markdown + impact map                        |
| `business/impact/`        | Impact maps                                                                |
| `memory/candidates/`      | Unverified candidate knowledge (discovered rules land here until promoted) |

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
 ├── analyzer (+ sql / api / ast / vue / java / xml / linkage / llm / llm-rules)
 ├── conflicts
 ├── evidence
 ├── knowledge (persistence + index)
 ├── validate (JSON Schema)
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
```

## Next implementation stage

详细方案、里程碑与取舍见 [ROADMAP.md](./ROADMAP.md)。概要：

1. 发布到 npm（改名为 `business-agent-cli`，含发布 CI）。
2. 评审闭环：`review` 命令、评审状态持久化、`autoPromote` 旋钮。
3. LLM 本地模型支持（Ollama）与上传隐私开关。
4. SQL 子查询 / 多 JOIN 关系提取、冲突解决建议、状态机与工作流建模。
