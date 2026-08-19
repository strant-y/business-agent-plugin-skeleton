# Business Agent 持续理解项目实施方案

## 1. 文档目标

本文档用于规划以下五项能力的落地：

1. 自动生命周期接入
2. 统一证据模型
3. 知识状态治理
4. 用户反馈闭环
5. 高质量任务检索

目标不是简单增加扫描规则，而是让插件从“被 Agent 主动调用的分析 CLI”升级为“嵌入 Agent 开发过程、能够持续积累项目理解的基础设施”。

目标闭环：

```text
Agent 开始任务
  -> 自动创建或恢复 session
  -> 召回相关项目知识和历史经验
  -> 生成修改前影响预测
  -> Agent 修改代码
  -> 自动捕获 diff
  -> 自动分析实际影响
  -> 记录测试、类型检查和 lint 结果
  -> 对比预测与实际
  -> 接收用户修正
  -> 生成带证据的知识候选
  -> 验证、升级或标记知识状态
  -> 后续任务按相关性召回
```

## 2. 当前基础和主要缺口

当前已经具备：

- `handleTaskEvent` 任务生命周期入口；
- task session、diff、测试结果和 task experience 持久化；
- 页面、动作、Store、Composable、API、状态机和 workflow 基础分析；
- diff finding 和影响映射；
- candidate、review、promote 基础流程；
- 预测与实际影响对比；
- 跨任务影响准确率统计。

现阶段主要问题：

- 生命周期虽然存在，但仍需要 Agent 或用户显式调用，自动接入不足；
- `evidence` 主要是字符串文件路径，没有统一的行号、片段、来源和版本信息；
- 知识状态只有有限的 candidate/confirmed/deprecated，缺少验证、过期和冲突治理；
- 用户纠错没有形成结构化反馈，不能稳定改变后续结果；
- 任务上下文主要依赖关键词，召回质量和可解释性不足；
- 预测准确率目前用于统计，尚未真正参与置信度和检索排序。

## 3. 总体架构

建议增加五个内部模块，并保持现有 CLI 和 API 兼容：

```text
Agent Integration
  - lifecycle adapter
  - event dispatcher
  - idempotency and recovery

Evidence
  - EvidenceRef
  - evidence normalizer
  - evidence validator

Knowledge Governance
  - versioning
  - status transition
  - corroboration
  - stale/conflict detection

Feedback
  - correction records
  - impact feedback
  - rule feedback
  - confidence adjustment

Retrieval
  - lexical index
  - entity/relation expansion
  - task similarity
  - ranking and explanation
```

推荐数据目录：

```text
.agent/
├── business/
│   ├── entities/
│   ├── relations/
│   ├── rules/
│   ├── states/
│   ├── workflows/
│   └── experiences/
├── memory/
│   ├── sessions/
│   ├── task-history/
│   ├── facts/
│   ├── candidates/
│   ├── observations/
│   ├── feedback/
│   ├── predictions/
│   ├── indexes/
│   │   ├── entity-index.json
│   │   ├── rule-index.json
│   │   ├── task-index.json
│   │   └── retrieval-index.json
│   │   ├── knowledge-state.json
│   │   └── impact-accuracy.json
│   └── events/
└── config.json
```

## 4. 自动生命周期接入

### 4.1 目标

Agent 不应依赖人工记忆下面的命令顺序：

```bash
business-agent task start
business-agent task predict-impact
business-agent task checkpoint
business-agent task test
business-agent task finish
```

这些命令仍保留作为手工兜底，但正常流程应由 Agent adapter、hook 或 middleware 自动触发。

### 4.2 统一事件接口

扩展现有 `TaskLifecycleEvent`，增加事件唯一 ID、工作区信息和来源：

```ts
interface TaskLifecycleEvent {
  eventId: string;
  taskId: string;
  sessionId?: string;
  phase: 'before_task' | 'before_context' | 'before_edit' | 'after_edit' | 'after_test' | 'after_task' | 'feedback';
  task: string;
  root: string;
  branch?: string;
  files?: string[];
  diff?: string;
  testResults?: TestObservation[];
  feedback?: FeedbackInput;
  source: 'agent-hook' | 'cli' | 'api' | 'git-hook' | 'editor';
  timestamp: string;
}
```

### 4.3 事件处理原则

#### 幂等

同一个 `eventId` 只能产生一次状态变化。处理过的事件写入：

```text
.agent/memory/events/<eventId>.json
```

重复事件直接返回之前的 `LifecycleResult`。

#### 可恢复

每个阶段完成后立即保存 session。进程中断后通过 `active-session.json` 恢复：

- 找不到 session：创建 warning，不静默创建新任务；
- 阶段已完成：返回已有结果；
- 阶段未完成：允许重试；
- `after_task` 必须支持重复调用而不重复写入经验和准确率。

#### 失败隔离

分析失败不能阻断 Agent 主任务。返回：

```ts
interface LifecycleWarning {
  phase: string;
  code: string;
  message: string;
  recoverable: boolean;
}
```

例如 diff 分析失败时仍然保存测试结果和 session，并把影响报告标记为 incomplete。

### 4.4 各阶段行为

#### before_task

- 创建或恢复 session；
- 解析任务关键词、实体别名和文件线索；
- 召回相关规则、关系、历史任务；
- 输出上下文和待确认问题；
- 保存 `predicted context`。

#### before_edit

- 读取 Agent 准备修改的文件；
- 生成影响预测；
- 保存预测版本和证据；
- 对高风险规则输出阻断级或提示级 warning。

#### after_edit

- 读取真实 Git diff；
- 生成 diff findings；
- 生成实际影响链；
- 与修改前预测对比；
- 保存 `actual impact` 和 missed/unexpected。

#### after_test

支持标准化记录：

```ts
interface TestObservation {
  command: string;
  kind: 'typecheck' | 'lint' | 'unit' | 'component' | 'e2e' | 'build' | 'custom';
  passed: boolean;
  exitCode?: number;
  output?: string;
  failedFiles?: string[];
  relatedRules?: string[];
  timestamp: string;
}
```

#### after_task

- 固化 task experience；
- 生成新事实和规则候选；
- 记录测试验证情况；
- 更新影响准确率；
- 更新检索索引；
- 对未经确认的内容只进入 candidate，不直接写入 confirmed。

### 4.5 Agent 集成方式

按侵入性从低到高支持三种方式：

1. CLI wrapper：适用于现有 Agent，通过统一脚本转发事件；
2. Node API adapter：适用于插件宿主，直接调用 `handleTaskEvent`；
3. Hook middleware：在 Agent 的 task/edit/test 生命周期中自动发送事件。

建议第一阶段实现 Node API adapter 和 CLI wrapper，第二阶段再接具体 Agent hook。插件核心不应依赖某一个 Agent 厂商或接口。

## 5. 统一证据模型

### 5.1 EvidenceRef

将当前实体、规则、关系、状态、影响映射中的字符串证据统一为：

```ts
export type EvidenceKind = 'source' | 'test' | 'diff' | 'schema' | 'task' | 'runtime' | 'human' | 'history';

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  commit?: string;
  taskId?: string;
  eventId?: string;
  description?: string;
  capturedAt: string;
  contentHash?: string;
}
```

### 5.2 兼容迁移

当前 `evidence: string[]` 不能一次删除。迁移分两步：

```ts
interface LegacyEvidenceSupport {
  evidence?: string[];
  evidenceRefs?: EvidenceRef[];
}
```

迁移规则：

- 旧字符串路径读取时转换为 `kind: source`；
- 新写入优先使用 `evidenceRefs`；
- Markdown 继续输出人类可读路径和行号；
- 经过一次 discover 或 task finish 后逐步补全证据；
- 删除旧字段前完成全量数据迁移和版本升级。

### 5.3 证据质量等级

证据质量不等于知识置信度，建议分开记录：

```ts
type EvidenceStrength = 'direct' | 'linked' | 'inferred';
```

- `direct`：源码行、测试断言、明确用户确认；
- `linked`：通过实体、关系或 API 链路推导；
- `inferred`：启发式或 LLM 推断。

规则：

- 只有 `inferred` 不能直接升级为 confirmed；
- 至少一个 direct 证据才能进入 corroborated；
- 测试通过可以提高 verified 置信度，但不能覆盖互相冲突的证据；
- 证据文件不存在或内容 hash 改变时必须重新校验。

### 5.4 影响链证据

影响映射不要只保存字符串数组，增加关系原因：

```ts
interface ImpactLink {
  target: string;
  relation: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
}

interface DiffImpactMapping {
  finding: DiffFinding;
  links: ImpactLink[];
  pages: string[];
  actions: string[];
  rules: string[];
  tests: string[];
  workflows: string[];
  entities: string[];
  apis: string[];
}
```

例如：

```text
orders.total_amount
  -> Order
     direct: SQL table orders matched entity alias Order
  -> GET /api/orders
     linked: API entity = Order
  -> OrderList
     linked: page calls GET /api/orders
```

## 6. 知识状态治理

### 6.1 状态模型

统一知识状态：

```text
candidate
  -> corroborated
  -> confirmed
  -> verified
  -> stale
  -> contradicted
  -> deprecated
```

状态含义：

- `candidate`：单一静态分析、LLM 或任务捕获产生的候选；
- `corroborated`：多个独立证据支持，但尚未人工确认；
- `confirmed`：用户或人工审核明确确认；
- `verified`：被测试、运行时观察或后续任务再次验证；
- `stale`：原始证据失效或无法找到；
- `contradicted`：新证据与当前知识冲突；
- `deprecated`：业务明确废弃。

### 6.2 知识记录模型

```ts
interface KnowledgeRecord {
  id: string;
  type: 'entity' | 'relation' | 'rule' | 'state' | 'workflow' | 'experience';
  subject: string;
  claim: string;
  confidence: Confidence;
  confidenceScore: number;
  status: KnowledgeStatus;
  source:
    | 'static-analysis'
    | 'llm-inference'
    | 'human-confirmed'
    | 'test-observation'
    | 'task-capture'
    | 'runtime-observation';
  evidence: EvidenceRef[];
  relatedTasks: string[];
  version: number;
  firstSeenAt: string;
  lastVerifiedAt?: string;
  supersedes?: string;
  conflictsWith?: string[];
  supersededBy?: string;
}
```

### 6.3 状态转移规则

禁止任意模块直接修改状态。统一通过：

```ts
transitionKnowledge(recordId, event): KnowledgeRecord
```

允许的主要转移：

```text
candidate -> corroborated   多个独立证据支持
candidate -> confirmed      人工明确接受
corroborated -> confirmed   人工明确接受
confirmed -> verified       测试或运行时再次验证
confirmed -> contradicted   新证据明确冲突
verified -> stale           证据失效
stale -> verified           新证据重新验证
任何状态 -> deprecated      业务明确废弃
```

每次转移都必须写入审计记录：

```ts
interface KnowledgeStateEvent {
  id: string;
  recordId: string;
  from: KnowledgeStatus;
  to: KnowledgeStatus;
  reason: string;
  evidence: EvidenceRef[];
  taskId?: string;
  actor: 'system' | 'agent' | 'user';
  timestamp: string;
}
```

### 6.4 过期和冲突检测

每次 `discover --deep`、`after_edit` 和 `after_task` 可执行轻量检测：

- 文件是否存在；
- 行号附近代码是否仍包含原片段；
- content hash 是否变化；
- 规则关联实体是否仍存在；
- 规则是否与新 finding 冲突；
- 规则是否仍有测试覆盖。

检测到冲突时：

1. 不覆盖旧知识；
2. 创建新版本；
3. 设置 `conflictsWith`；
4. 生成 review candidate；
5. 在 context 和 impact 输出冲突 warning。

## 7. 用户反馈闭环

### 7.1 反馈类型

用户反馈必须结构化，至少支持：

```ts
type FeedbackType =
  | 'accept_impact'
  | 'reject_impact'
  | 'add_missing_impact'
  | 'confirm_rule'
  | 'reject_rule'
  | 'merge_entities'
  | 'split_entities'
  | 'correct_relation'
  | 'mark_stale'
  | 'mark_deprecated';
```

### 7.2 反馈接口

```ts
interface FeedbackInput {
  type: FeedbackType;
  targetId: string;
  correction?: string;
  expectedTarget?: string;
  evidence?: EvidenceRef[];
  reason?: string;
}

interface FeedbackRecord extends FeedbackInput {
  id: string;
  taskId: string;
  sessionId: string;
  originalPrediction?: string;
  createdAt: string;
}
```

反馈写入：

```text
.agent/memory/feedback/<taskId>-<feedbackId>.json
```

### 7.3 反馈处理

#### 影响误报

- 记录原始 finding 和目标；
- 下调对应匹配策略的置信度；
- 不直接删除 analyzer 结果；
- 后续相同模式只输出低置信度或降低排序。

#### 漏报

- 把用户补充目标加入实际影响集合；
- 保存用户证据；
- 形成可检索经验；
- 后续相同实体/关系优先召回。

#### 规则确认

- candidate 进入 confirmed；
- 保存 human evidence；
- 关联当前 task；
- 后续 discover 不得静默覆盖。

#### 实体合并/拆分

- 建立 alias 或 canonical ID；
- 保留原实体历史；
- 影响关系和任务记录迁移到 canonical ID；
- 产生审计记录。

### 7.4 反馈对准确率的影响

当前准确率统计继续保留，但额外记录带反馈修正的准确率：

```text
raw accuracy       原始分析结果
corrected accuracy 用户修正后的结果
```

统计维度建议增加：

- analyzer 类型；
- finding kind；
- entity；
- 项目路径；
- 框架类型；
- 规则或匹配策略。

当某类规则连续误报时，自动降低其默认置信度；当某类规则连续被确认时，提高排序权重，但不能跳过人工确认状态。

## 8. 高质量任务检索

### 8.1 检索目标

任务上下文不能只返回“包含关键词的文件”，而应返回：

- 为什么召回；
- 证据是什么；
- 与当前任务的关系；
- 置信度是多少；
- 哪些内容是历史经验，哪些是当前代码直接证据。

### 8.2 检索索引

第一阶段使用 JSON 索引，不立即引入向量数据库：

```ts
interface RetrievalDocument {
  id: string;
  type: 'entity' | 'rule' | 'relation' | 'workflow' | 'task' | 'feedback' | 'evidence';
  title: string;
  tokens: string[];
  aliases: string[];
  relatedIds: string[];
  status?: KnowledgeStatus;
  confidence?: number;
  updatedAt: string;
}
```

索引来源：

- discovery manifest；
- confirmed/verified knowledge；
- candidate 中的高质量内容；
- task experience；
- feedback；
- API path、页面 route、Store 名称、状态名。

### 8.3 分层检索

按以下顺序执行：

1. 任务关键词和实体名精确匹配；
2. 实体别名和文件模块匹配；
3. 关系图邻居扩展；
4. 页面、Store、API、状态、规则联合匹配；
5. 历史任务相似度匹配；
6. 反馈记录修正排序；
7. 根据状态、证据强度和准确率加权。

建议评分：

```text
score =
  0.30 * keywordMatch
+ 0.20 * entityMatch
+ 0.15 * relationDistance
+ 0.15 * fileEvidenceMatch
+ 0.10 * taskSimilarity
+ 0.05 * verifiedBoost
+ 0.05 * feedbackBoost
- stalePenalty
- contradictionPenalty
```

分数只是排序依据，不代表业务真相。

### 8.4 召回结果格式

```ts
interface RetrievalHit {
  id: string;
  type: RetrievalDocument['type'];
  title: string;
  score: number;
  confidence: Confidence;
  reasons: string[];
  evidence: EvidenceRef[];
  warnings: string[];
}
```

示例：

```text
OrderStore
score: 0.91
命中原因：
- 任务包含“订单”
- 当前文件名包含 order
- 历史任务曾修改 Order.status
- OrderStore 与 Order 存在 uses_entity 关系
证据：
- src/stores/orderStore.ts:12
- task-history/order-audit-20260817.json
```

### 8.5 任务相似度

初期不使用 embedding，采用结构化相似度：

- 任务关键词交集；
- changed files 模块交集；
- affected entities 交集；
- finding kind 交集；
- API path 交集；
- 状态名交集；
- 用户反馈标签交集。

只有在 JSON 索引和排序质量稳定后，再考虑 embedding 作为补充，不替代证据检索。

## 9. 实施顺序

### 阶段一：自动生命周期和恢复

目标：每个 Agent 任务都能自动留下完整 session。

任务：

- 增加 `eventId`、`source`、`root`、`branch`；
- 增加事件幂等存储；
- 完善 active session 恢复；
- 让 `after_task` 可重复执行；
- 增加统一 lifecycle adapter；
- 统一测试、lint、typecheck、build 结果结构。

验收：

- 重复发送同一事件不会重复写入 experience；
- Agent 中断后可以继续原 session；
- 任何阶段失败都有 warning 和可恢复状态；
- 手工 CLI 与 API adapter 结果一致。

### 阶段二：统一证据模型

任务：

- 增加 `EvidenceRef`；
- 对 source、diff、test、task、human 建立转换器；
- 新写入全部使用 `evidenceRefs`；
- 为旧 manifest 提供兼容读取；
- 在 Markdown 和 JSON 报告中显示证据来源；
- 增加 content hash 和行号校验。

验收：

- 每个候选规则至少有一个可追溯证据；
- 影响链每个目标都有映射原因；
- 证据文件变化后能被识别；
- 旧 `.agent` 数据升级后不丢失。

### 阶段三：知识状态治理

任务：

- 增加 KnowledgeRecord；
- 统一状态转移函数；
- 增加版本和审计日志；
- 实现 stale 检测；
- 实现 contradicted 检测；
- review/promote 改为调用状态转移；
- 禁止分析器直接写 confirmed。

验收：

- 静态分析不能直接生成 confirmed；
- 旧知识不会被新 discover 静默覆盖；
- 冲突知识可查看双方证据；
- 证据失效后知识会进入 stale 或 review 队列。

### 阶段四：用户反馈闭环

任务：

- 增加 feedback 事件和 CLI/API；
- 支持接受、拒绝、补充、确认、过期、合并和拆分；
- 反馈关联 task/session/finding；
- 反馈结果进入 experience 和检索索引；
- 统计原始准确率与修正准确率；
- 按 analyzer/finding/entity 统计误报与漏报。

验收：

- 用户标记误报后，后续结果可见排序或置信度变化；
- 用户补充漏报后，经验可以被相似任务召回；
- 用户确认规则后，规则状态变为 confirmed 并保存 human evidence；
- 所有反馈都有审计记录。

### 阶段五：高质量任务检索

任务：

- 建立 JSON retrieval index；
- 增加实体别名；
- 增加关系图扩展；
- 增加历史任务结构化摘要；
- 增加评分、状态惩罚和 feedback boost；
- 输出召回理由和证据；
- 增加检索评测集。

验收：

- 相关历史任务排名高于无关任务；
- stale/contradicted 知识默认降权；
- 召回结果都有解释；
- 相同任务重复执行时能召回上次修正和经验。

## 10. 测试策略

### 10.1 生命周期测试

- before_task 创建 session；
- 相同 eventId 重放不重复处理；
- before_edit 保存预测；
- after_edit 保存实际影响；
- after_test 保存多种验证结果；
- after_task 只生成一次 experience；
- session 中断后恢复；
- 分析失败仍保存 session 和 warning。

### 10.2 证据测试

- 旧字符串 evidence 可转换；
- source evidence 保留文件和行号；
- diff evidence 保留 finding 和片段；
- test evidence 关联测试命令；
- content hash 变化后被标记；
- 影响链输出 relation 和 evidence。

### 10.3 状态治理测试

- candidate 到 corroborated；
- candidate 到 confirmed；
- confirmed 到 verified；
- 证据失效到 stale；
- 冲突到 contradicted；
- deprecated 不被普通 discover 恢复；
- 状态转移审计完整。

### 10.4 反馈测试

- 接受影响；
- 拒绝误报；
- 补充漏报；
- 确认规则；
- 合并实体；
- 标记知识过期；
- 反馈影响后续置信度和排序。

### 10.5 检索测试

建立固定评测数据集，每条任务包含：

```ts
interface RetrievalCase {
  task: string;
  expected: string[];
  rejected?: string[];
}
```

评估：

- Recall@5；
- Precision@5；
- MRR；
- 召回理由完整率；
- stale/contradicted 误召回率；
- 用户修正后的排序变化。

## 11. 质量和安全边界

必须坚持以下原则：

- 静态分析和 LLM 只能生成候选，不能无证据确认业务事实；
- 用户反馈优先于启发式推断，但反馈也必须留存来源；
- 新知识不能覆盖旧知识，必须保留版本和冲突关系；
- 任务历史不能把 secret、token、密码和完整敏感响应写入证据；
- 运行命令输出需要截断、脱敏和大小限制；
- 检索结果必须显示证据和状态，不能只给结论；
- 影响分析失败不能阻断用户的正常开发流程；
- 准确率只能调整排序和置信度，不能自动绕过人工审核。

## 12. 推荐新增接口

建议在现有 `src/index.ts` 中逐步导出以下能力：

```ts
export { dispatchLifecycleEvent, loadEventResult, type LifecycleAdapter } from './core/lifecycle.js';

export { normalizeEvidence, validateEvidence, type EvidenceRef } from './core/evidence.js';

export {
  transitionKnowledge,
  validateKnowledgeState,
  type KnowledgeRecord,
  type KnowledgeStateEvent,
} from './core/knowledge-state.js';

export { recordFeedback, applyFeedback, type FeedbackInput, type FeedbackRecord } from './core/feedback.js';

export { rebuildRetrievalIndex, retrieveTaskContext, type RetrievalHit } from './core/retrieval.js';
```

命令层建议增加：

```text
business-agent task feedback <target> [options]
business-agent knowledge status [id]
business-agent knowledge verify <id>
business-agent knowledge stale
business-agent retrieve <task>
business-agent index rebuild
```

这些命令必须调用核心模块，不能在 CLI 中重复实现业务逻辑。

## 13. 最终验收标准

当下面流程能够稳定运行时，才认为五项能力基本完成：

```text
1. Agent 自动发送 before_task
2. 插件创建 session 并召回实体、规则、关系和历史经验
3. Agent 发送 before_edit，插件保存预测影响
4. Agent 修改代码后自动发送 after_edit，插件捕获 diff
5. Agent 发送 after_test，插件记录 typecheck/lint/test/build
6. Agent 发送 after_task，插件保存 experience 和候选知识
7. 用户可以标记误报、补充漏报和确认规则
8. 反馈改变知识状态、准确率和后续排序
9. 下一次相似任务能召回历史经验和用户修正
10. 所有结论都能追溯到源码、测试、diff、任务或人工证据
```

## 14. 推荐执行原则

实现顺序必须遵循：

```text
生命周期可靠性
  > 证据可追溯性
  > 知识状态安全性
  > 用户反馈有效性
  > 检索排序质量
  > 更复杂的语义分析
```

不要在生命周期没有自动接入、证据没有统一之前继续堆叠更多正则 analyzer。否则系统会产生更多候选，但不会真正变得更懂项目。

最终目标是：

```text
每次任务自动记录
  -> 每个结论带证据
  -> 用户可以修正
  -> 知识状态可演进
  -> 后续任务可召回
  -> 准确率持续改善
```

这才是“随着 Agent 使用，逐渐熟悉并理解项目业务及代码规则”的可验证实现路径。
