# Roadmap：从 skeleton 到可发布、可用的业务知识工具

> 本文针对四个已知限制给出设计方案、里程碑与取舍。每个方案都遵循本项目原则：
> 零运行时依赖优先、保守默认、知识分层（候选 → 确认）、失败可见但不中断。

## 现状与问题

| #   | 问题             | 现状                                                                                            |
| --- | ---------------- | ----------------------------------------------------------------------------------------------- |
| 1   | 未发布到 npm     | 只能 `npm link` 或 `npm publish` 后使用；包名 `business-agent` 已被 npm 占用（实测存在 v0.3.0） |
| 2   | 知识需人工确认   | discover 产出 low/medium 候选，须手动 promote；重复 discover 会重新生成候选，无评审状态记忆     |
| 3   | LLM 分析器门槛高 | 需外部 API key；会把源码片段发往远端；默认关闭                                                  |
| 4   | 三项能力待办     | SQL 仅单表 JOIN；冲突只有检测无建议；states/workflows 目录为空壳                                |

---

## 问题一：npm 发布

### 命名（已核实注册表）

| 候选名                     | 状态      | 评价                                                             |
| -------------------------- | --------- | ---------------------------------------------------------------- |
| `business-agent`           | ❌ 已占用 | 无法使用                                                         |
| `business-agent-cli`       | ✅ 可用   | **推荐**：语义清晰、SEO 好，bin 名可保持 `business-agent` 不变   |
| `@strant-y/business-agent` | ✅ 可用   | 最稳妥（scope 独占），但需 `--access public`，且要求拥有该 scope |
| `ba-cli`                   | ✅ 可用   | 短但语义弱，不推荐                                               |

**决策：改名为 `business-agent-cli`，bin 名保持 `business-agent`。** 用户安装后命令无变化，零迁移成本。

### 发布管线

1. **package.json**：
   - `name: "business-agent-cli"`，`bin` 不变；
   - 新增 `"prepublishOnly": "npm run check && npm run lint && npm run format:check && npm test && npm run build"`——发不出去的包过不了质量门禁。
2. **GitHub Actions `publish.yml`**（触发 `v*` tag）：
   ```yaml
   on: { push: { tags: ["v*"] } }
   jobs:
     publish:
       steps:
         - checkout
         - setup-node（registry-url: https://registry.npmjs.org）
         - npm ci
         - npm run build
         - npm publish --access public
       env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```
   （若采用 scoped 名，`--access public` 为必需。）
3. **版本流程**：`npm version patch|minor|major` 自动打 tag → push 触发发布；发布前本地 `npm pack --dry-run` 复核内容。
4. **npm 账号**：需在 GitHub 仓库 Secrets 配置 `NPM_TOKEN`（npm 账号 → Access Tokens → Automation）。

---

## 问题二：人工确认负担

核心思路：**先降噪、再提供批量评审工作流、最后给一个可选的自动提升旋钮**（默认仍保守）。

### 2.1 候选降噪（减少待审数量）

- **同类聚合**：vue 分析器当前每个 `v-if`/`:disabled` 都产出一条独立候选 → 按 `(模式, 实体)` 聚合为一条，证据合并（上限 10 条）。同一实体的同一类约束只审一次。
- **证据行级化**：候选 markdown 增加 `## Context` 节，摘录匹配行前后 3 行（detectRules / vue / java 分析器记录行号与片段），评审时无需打开源码。
- **相似去重**：规则文本归一化（小写、去空白）后按 `(entity, text)` 再排重。

### 2.2 `review` 命令（批量评审工作流）

```
business-agent review                        # 交互模式
business-agent review --non-interactive --accept medium --reject low   # 脚本/CI 模式
business-agent review --json                 # 机器可读
```

- 交互模式逐条展示：名称 / 实体 / 置信度 / 证据 / Context 片段；输入 `y`(promote) `n`(reject) `e`(补充 entity 后 promote) `q`(退出)。
- promote 复用现有逻辑（schema 校验 + impact map + 标记 promoted）；reject 把候选移入 `memory/candidates/rejected/`。
- 输出摘要：`Reviewed X, promoted Y, rejected Z, pending N`。

### 2.3 评审状态持久化（关键设计）

新增 `.agent/memory/review-state.json`：

```json
{
  "decisions": {
    "rule.vue.if-xxx-0": { "decision": "promoted", "at": "2026-08-15T00:00:00Z" },
    "rule.discovery.thrown-error": { "decision": "rejected", "at": "2026-08-15T00:00:00Z" }
  }
}
```

- **discover 写候选前检查该文件：已 promoted/rejected 的候选不再重写、不复活**——解决"每次 discover 都重新生成已处理候选"的问题。
- review 决策同时写入此文件；该文件纳入 `.agent/` 模板与知识模型文档。

### 2.4 自动提升旋钮（可选快路径）

- 配置 `autoPromote: "never" | "high" | "medium"`，默认 `"never"`（保持现有保守策略）。
- discover 时对置信度 ≥ 阈值的规则候选直接走 promote 路径，并在 review-state 记录为 `auto-promoted`。
- 文档明确：autoPromote 只影响规则候选；关系仍按现状直接落盘。

### 2.5 discover 报告增强

输出新增 `Pending candidates: N（business-agent review 待处理）`。

---

## 问题三：LLM 分析器

### 3.1 本地模型支持（解决 API key 门槛）

- `completeLlm` 目前无 key 直接跳过 → 修改：`llm.apiKeyEnv` 设为 `""` 或 `"none"` 时**不发送 Authorization 头**（Ollama / LM Studio 不需要）。
- 新增 provider 枚举 `"ollama"`：默认 `baseUrl: "http://localhost:11434/v1"`，配合 `model: "qwen2.5-coder:7b"` 一行配置可用。
- 文档化完整流程：`ollama pull qwen2.5-coder:7b` → 启动 → 配置 → `discover --deep`。默认 baseUrl 仍为 api.openai.com，云端用户无感知。

### 3.2 隐私与上传控制

- 新增配置 `llm.allowSourceUpload`（默认 `false`）：
  - llm-rules 只有在 `true` 时才发送代码片段；`false` 时自动跳过并告警（README 说明）。
  - llm 实体描述分析器只发送实体名/属性名（低风险），不受该开关限制——文档明确区分两者。
- 上传前**脱敏**：新增 `redactSecrets(text)`（正则移除常见密钥形态：`sk-…`、`AKIA…`、`password=…`、JWT 形态等），llm-rules 发送前应用。
- 超时（30s）/ 重试（2 次指数退避）已具备。

### 3.3 配置体验

- 新增 `business-agent config` 命令：
  - `config` 打印合并后配置；
  - `config get <key>` / `config set <key> <value>`（支持点路径，如 `llm.baseUrl http://localhost:11434/v1`），写入 `.agent/business-agent.json`。
- 缓解"JSON 无注释"的配置门槛；README 配置表保持为权威文档。

---

## 问题四：三项能力待办

### 4.1 SQL 子查询 / 多 JOIN 关系提取

- 在 `src/core/analyzers/parse.ts` 新增**轻量递归下降解析器**（tokenizer + 查询块解析，约 300 行，零新依赖）：
  - 支持：嵌套 SELECT（含 `IN`/`EXISTS` 子查询）、多 JOIN（LEFT/RIGHT/INNER/OUTER/CROSS）、表别名（AS/隐式）、CTE（`WITH … AS (…)`）、UNION 块、DML 中的表引用。
  - 关系生成规则：
    - 每个查询块：FROM 基表 + 每个 JOIN 对 → `relation`（kind: `join`）；
    - 子查询位于 `IN`/`EXISTS`：外层表 ↔ 内层基表 → `relation`（kind: `subquery-filter`，基数 N:1）；
    - JOIN ON 条件两侧列名一致 → 置信度 medium。
- 兼容策略：保留现有 `parseSqlRelations` 行为与全部旧测试；新增 `parseSqlDeep` 供 sql/xml 分析器升级调用。无法解析的语句**跳过不报错**（手写解析器只做保守提取，不误报）。
- 明确不支持：存储过程体、PL/SQL 块、方言特有语法（文档注明）。

### 4.2 冲突解决建议 + 生命周期闭环

- schema 扩展：`schemas/conflict.schema.json` 与 `types.ts` 增加 `suggestions?: string[]`。
- `conflicts.ts` 启发式生成建议：
  1. 双方 preconditions 不同且非空 → "用前置条件合并两条规则（不同条件分别适用）"；
  2. 置信度差异大（一方 high 一方 low）→ "以高置信度规则为准，复核低置信度规则证据"；
  3. 证据文件重叠 → "同一来源的矛盾约束，建议人工合并"；
  4. 否则 → "在 review 中确认哪条已过时，deprecate 旧规则"。
- 展示：`context <subject>` 的 Rule Conflicts 段落直接列出建议；新增 `business-agent conflicts` 命令（列表 + 建议 + `--json`）。
- 配套新增 `business-agent deprecate <rule-id>`：把规则 `status` 置 `deprecated`、更新 markdown 与 impact map——补齐知识生命周期（此前 status 枚举存在但无命令可达）。

### 4.3 状态机 / 工作流建模（分两步，先状态机）

**第一步：`states` 分析器**（新 analyzer，挂入 `--deep`）：

- 状态提取：TS 联合字符串字面量（AST 扩展）、Java enum 常量、SQL `CHECK`/`ENUM` 状态列、Vue 模板状态比较。
- 迁移提取：service 方法中 `x.setStatus(Y)` / `x.status = Y` 赋值（Java 侧在现有 THROW_RE 上下文，TS 侧用 AST 赋值节点）；迁移守卫 = 所在分支的 rule。
- 新知识类型 `StateModel`：`{ id, entity, states[], transitions: [{ from, to, guard?, evidence, confidence }] }`；新增 `schemas/state.schema.json`。
- 落盘：`.agent/business/states/<entity>.json + .md`（md 内含 mermaid `stateDiagram-v2`，人和 agent 都能读）。
- 新命令 `business-agent states [entity]`：输出 mermaid 图 / `--json`。
- 质量控制：全部 `low` 置信度候选，须 review/promote 才进 `business/states/`——与知识模型一致。

**第二步：workflows 轻量支持**（不做自动流程推理）：

- 模板：`templates/agent/business/workflows/example.md`（参与者 / 步骤 / 涉及实体 / 规则与状态图链接）。
- 新命令 `business-agent workflow <name>`：生成流程骨架文档。
- `context <subject>` 把匹配实体的 states/workflows 链接进上下文。
- 自动流程推理留待后续（LLM 增强或人工撰写），本阶段只做脚手架 + 集成。

---

## 里程碑与落地顺序

| 版本      | 主题                | 内容                                                                                                                                                              |
| --------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.2.0** | 发布 + 评审闭环     | 改名 `business-agent-cli`、publish CI、`review` 命令 + review-state 持久化、`autoPromote`、候选聚合降噪、LLM 本地模型 + `allowSourceUpload` + 脱敏、`config` 命令 |
| **0.3.0** | 深度 SQL + 冲突闭环 | SQL 子查询/多 JOIN/CTE 解析、冲突建议 + `conflicts` 命令、`deprecate` 命令                                                                                        |
| **0.4.0** | 状态机 + 工作流     | `states` 分析器 + mermaid 输出、`workflow` 命令 + context 集成                                                                                                    |

每版本流程：`npm version` 打 tag → 推 tag 触发 CI 发布 → 更新 CHANGELOG。

## 风险与取舍

- **改名**：已 `npm link` 的本地用户需重新 link；bin 名不变则命令无感。
- **review 交互**：使用 Node `readline`，Windows 终端可用；`--non-interactive` 保证 CI 可脚本化。
- **SQL 手写解析器**：有方言边界，策略是"解析不了就跳过"，宁可少报不可错报；若未来噪声/需求增长，再评估引入 `node-sql-parser`。
- **LLM 上传默认关闭**：安全默认；本地模型路径完全离线，敏感代码库推荐。
- **状态机推断**：噪声高，全部低置信度候选进入评审流，不自动进确认库。
