# Business Agent 插件优化方案

## 1. 文档目标

当前插件已经具备以下基础能力：

- 扫描项目并发现业务实体、关系和规则候选；
- 将知识保存到 `.agent/`；
- 为任务生成业务上下文；
- 分析修改文件可能影响的实体、规则、关系和 API；
- 通过 `capture` 和 Git hook 保存任务历史。

但当前插件本质上仍是一个“源码扫描 + 文件知识库 + 影响辅助分析”工具，尚未成为能够随着 Agent 工作过程自动学习、自动召回、自动验证和持续修正知识的系统。

本方案的目标是将插件升级为：

> 面向前端业务开发的项目知识与变更影响 Agent 基础设施。

核心目标不是让插件保存更多 Markdown，而是让 Agent 在每个任务中都能够理解上下文、识别业务关系、预测修改影响，并将已验证的新知识沉淀下来。

---

## 2. 总体目标

插件最终需要支持以下闭环：

```text
任务开始
  -> 召回相关项目知识
  -> 分析任务涉及的业务对象、规则和历史经验
  -> 修改前生成影响预测
  -> Agent 修改代码
  -> 自动捕获 diff、测试和类型检查结果
  -> 分析实际变更影响
  -> 对比预测与实际结果
  -> 提取新业务事实和开发经验
  -> 评估置信度
  -> 自动更新知识或进入审核队列
```

当前流程：

```text
discover -> context -> 修改 -> impact -> capture
```

目标流程：

```text
before_task
  -> retrieve_context
  -> predict_impact
  -> before_edit
  -> after_edit
  -> run_validation
  -> compare_prediction
  -> learn
  -> review_or_promote
  -> after_task
```

---

## 3. 当前问题

### 3.1 Agent 使用过程没有自动接入

目前知识积累主要依赖显式执行：

```text
business-agent discover --deep
business-agent context <subject>
business-agent impact
business-agent capture --learn <fact>
```

Git hook 只能在提交后运行 `capture`，无法覆盖：

- Agent 开始任务时；
- Agent 准备修改文件时；
- Agent 每次编辑之后；
- 测试失败和修复过程中；
- Agent 对话中出现的新业务事实。

### 3.2 影响分析仍然以文件为中心

当前主要判断：

```text
某文件 -> 关联某实体或关系
```

还不能精确识别：

- 修改了哪个字段；
- 新增或删除了哪个状态；
- API 参数或返回结构是否变化；
- 哪个条件分支发生变化；
- 哪条业务规则可能被破坏；
- 哪些测试、页面和接口必须同步修改。

### 3.3 业务知识与代码证据关联还不够强

当前实体、规则和关系可以保存证据文件，但缺少完整的：

- 行号和代码片段版本；
- 产生知识的任务；
- 知识最后验证时间；
- 知识是否已过期；
- 知识被哪些测试验证；
- 知识与其他规则的冲突关系。

### 3.4 前端模型还不完整

目前已经支持 Vue、TypeScript、Pinia、Vuex、Composable 和 API wrapper，但主要还是：

```text
组件 -> Store -> Entity -> API
```

缺少更重要的业务概念：

- 页面；
- 用户动作；
- 前置条件；
- 状态转换；
- 权限；
- 表单校验；
- 业务流程；
- 成功和失败后的状态变化。

### 3.5 LLM 输出需要更严格的证据约束

LLM 可以帮助归纳和消歧，但不能直接把推断当作已确认业务事实。

所有 LLM 结论必须能够追溯到：

- 源码；
- 测试；
- API schema；
- 历史任务；
- 人工确认。

---

## 4. 目标架构

建议将插件拆分为六个核心层次：

```text
Agent Integration Layer
  -> Task Lifecycle
  -> Context Retrieval
  -> Change Events

Analysis Layer
  -> Project Scanner
  -> TypeScript/Vue AST
  -> Frontend Flow Analyzer
  -> Diff Analyzer
  -> Test/API Schema Analyzer

Knowledge Layer
  -> Facts
  -> Entities
  -> Relations
  -> Rules
  -> State Machines
  -> Workflows
  -> Task Experiences

Evidence Layer
  -> Source Evidence
  -> Test Evidence
  -> Runtime Evidence
  -> Human Evidence
  -> Git/Diff Evidence

Validation Layer
  -> Typecheck
  -> Lint
  -> Unit Tests
  -> E2E Tests
  -> Rule Validation
  -> Prediction vs Actual Comparison

Review Layer
  -> Candidate Review
  -> Conflict Detection
  -> Knowledge Promotion
  -> Stale/Contradicted Handling
```

---

## 5. Agent 生命周期接入

这是最高优先级工作。插件应该提供标准任务生命周期，而不是只提供独立 CLI 命令。

### 5.1 生命周期事件

建议支持：

```text
before_task
before_context
before_edit
after_edit
after_test
after_task
```

### 5.2 各阶段职责

#### before_task

输入：

- 任务描述；
- 当前分支；
- 当前项目路径；
- Agent 会话 ID。

执行：

- 识别任务中的业务对象和关键词；
- 召回相关实体、规则、关系和历史任务；
- 生成任务上下文；
- 输出待确认问题。

#### before_edit

执行：

- 分析准备修改的文件；
- 找到相关业务对象和规则；
- 预测可能影响的页面、Store、API、后端实体和测试；
- 提醒高风险规则。

#### after_edit

执行：

- 读取 Git diff；
- 识别字段、状态、API、权限和校验变化；
- 重新生成影响报告；
- 对比修改前的影响预测。

#### after_test

记录：

- 测试命令；
- 通过或失败；
- 失败文件；
- 失败原因；
- 修复涉及的文件；
- 哪些业务规则被验证。

#### after_task

执行：

- 保存任务摘要；
- 保存变更文件和 diff 摘要；
- 保存预测影响与实际影响；
- 提取新的业务事实；
- 提取可复用开发经验；
- 将未经确认的内容放入候选队列。

### 5.3 推荐接口

```ts
interface TaskLifecycleEvent {
  taskId: string;
  sessionId?: string;
  phase: 'before_task' | 'before_edit' | 'after_edit' | 'after_test' | 'after_task';
  task: string;
  files?: string[];
  diff?: string;
  testResults?: TestResult[];
  timestamp: string;
}

interface LifecycleResult {
  context?: ActiveContext;
  impact?: ImpactReport;
  candidates?: KnowledgeCandidate[];
  warnings: string[];
}
```

---

## 6. 结构化项目知识模型

不能只依赖 Markdown。Markdown 应作为人类可读视图，底层应该有结构化 JSON 数据。

### 6.1 统一事实模型

```ts
interface KnowledgeFact {
  id: string;
  subject: string;
  predicate: string;
  object?: string;
  type: 'entity' | 'relation' | 'rule' | 'state' | 'workflow' | 'experience';
  claim: string;
  confidence: 'low' | 'medium' | 'high';
  confidenceScore?: number;
  status: 'candidate' | 'corroborated' | 'confirmed' | 'verified' | 'stale' | 'contradicted' | 'deprecated';
  source:
    | 'static-analysis'
    | 'llm-inference'
    | 'human-confirmed'
    | 'test-observation'
    | 'task-capture'
    | 'runtime-observation';
  evidence: EvidenceRef[];
  relatedTasks: string[];
  firstSeenAt: string;
  lastVerifiedAt?: string;
  supersedes?: string;
  conflictsWith?: string[];
}

interface EvidenceRef {
  kind: 'source' | 'test' | 'diff' | 'schema' | 'task' | 'runtime' | 'human';
  file?: string;
  line?: number;
  snippet?: string;
  commit?: string;
  description?: string;
}
```

### 6.2 知识来源必须明确

每条知识都要区分来源：

```text
static-analysis     静态分析发现
llm-inference       LLM 推断
human-confirmed     人工确认
test-observation    测试观察
 task-capture        任务总结
runtime-observation 运行时观察
```

其中：

- `static-analysis` 只能产生候选；
- `llm-inference` 只能产生候选；
- `human-confirmed` 可以确认事实；
- `test-observation` 可以提升置信度；
- `runtime-observation` 可以补充实际行为；
- 没有证据的知识不能自动升级为 confirmed。

### 6.3 建议目录

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
│   ├── facts/
│   ├── candidates/
│   ├── task-history/
│   ├── sessions/
│   ├── predictions/
│   └── observations/
└── indexes/
    ├── entity-index.json
    ├── relation-index.json
    ├── rule-index.json
    ├── task-index.json
    └── retrieval-index.json
```

---

## 7. 知识生命周期

当前的：

```text
candidate -> review -> confirmed
```

建议升级为：

```text
candidate
  -> corroborated
  -> confirmed
  -> verified
  -> stale
  -> contradicted
  -> deprecated
```

### 7.1 状态规则

- 同一事实被多个独立证据支持：`candidate -> corroborated`；
- 被人工确认：`-> confirmed`；
- 被测试、运行时或后续任务验证：`-> verified`；
- 原始证据消失：`-> stale`；
- 新代码或新事实与其冲突：`-> contradicted`；
- 业务明确废弃：`-> deprecated`。

### 7.2 禁止静默覆盖

发现新规则时，不应直接覆盖旧规则。应该保存：

```text
旧知识
新知识
冲突证据
产生冲突的任务
建议处理方式
```

### 7.3 过期检测

每次 `discover --deep` 后执行：

1. 检查知识证据文件是否还存在；
2. 检查证据行内容是否发生变化；
3. 检查相关实体、字段和状态是否仍存在；
4. 检查规则是否仍被测试覆盖；
5. 对失效知识标记 `stale`；
6. 对矛盾知识标记 `contradicted`。

---

## 8. 前端业务模型升级

### 8.1 分离技术对象和业务对象

不要将所有对象都作为同一种 `business_entity`。

建议至少区分：

```text
DomainEntity       领域实体，例如 Order、Customer
FrontendStore      前端状态容器
Composable         可复用业务逻辑
Page               页面
Component          UI 组件
ApiClient          API 封装
BackendApi         后端接口
DatabaseTable      数据表
BusinessRule       业务规则
```

这样可以避免把 `OrderList.vue` 和 `Order` 混淆为同类业务对象。

### 8.2 页面模型

```ts
interface FrontendPage {
  id: string;
  route?: string;
  component: string;
  permissions?: string[];
  stores: string[];
  apiCalls: string[];
  actions: string[];
  evidence: EvidenceRef[];
}
```

### 8.3 用户动作模型

```ts
interface UserAction {
  id: string;
  name: string;
  source: string;
  trigger: 'click' | 'submit' | 'route' | 'watch' | 'startup' | 'event';
  preconditions: string[];
  stateReads: string[];
  stateWrites: string[];
  apiCalls: string[];
  successEffects: string[];
  failureEffects: string[];
  evidence: EvidenceRef[];
}
```

### 8.4 状态机模型

```ts
interface BusinessStateMachine {
  entity: string;
  states: string[];
  transitions: Array<{
    from?: string;
    to: string;
    trigger?: string;
    guard?: string;
    effects?: string[];
    evidence: EvidenceRef[];
  }>;
}
```

### 8.5 业务流程模型

```text
创建订单
  -> 保存草稿
  -> 提交审核
  -> 审核通过
  -> 支付
  -> 完成
```

流程应关联：

- 页面；
- 用户动作；
- Store；
- API；
- 状态机；
- 业务规则；
- 测试。

---

## 9. 从文件级影响分析升级为 Diff 级影响分析

### 9.1 变更分类

Diff 分析至少要识别：

```text
实体字段新增
实体字段删除
实体字段类型变化
状态值新增
状态值删除
状态转换变化
规则条件变化
API 路径变化
API 方法变化
请求参数变化
响应类型变化
权限条件变化
表单校验变化
数据库字段变化
测试变化
```

### 9.2 影响推导规则

```text
修改实体字段
  -> 影响 API 类型
  -> 影响 API wrapper
  -> 影响 Store
  -> 影响组件 props 和表单
  -> 影响序列化和校验
  -> 影响相关测试
```

```text
修改状态转换
  -> 影响状态机
  -> 影响按钮 disabled 条件
  -> 影响页面显示条件
  -> 影响 Store action
  -> 影响后端状态校验
  -> 影响流程测试
```

```text
修改 API 返回类型
  -> 影响 API wrapper
  -> 影响 Store 状态
  -> 影响组件展示
  -> 影响类型检查
  -> 影响相关 E2E 测试
```

```text
修改权限判断
  -> 影响路由守卫
  -> 影响菜单和按钮
  -> 影响接口鉴权
  -> 影响角色测试
```

### 9.3 目标影响报告

影响报告不应只输出：

```text
Affected entity: Order
```

而应该输出：

```text
检测到 Order.status 的状态判断发生变化：

影响对象：
1. OrderStore.canEdit
2. OrderEdit.vue 的 disabled 条件
3. POST /api/orders/{id}
4. Order 状态机
5. rule.order-audit-locked
6. tests/order-edit.test.ts

风险：
- 审核状态下的编辑限制可能被放宽；
- 前端和后端状态判断可能不一致；
- 建议补充状态迁移和权限测试。
```

### 9.4 预测与实际对比

保存修改前预测：

```json
{
  "predicted": ["OrderStore", "OrderEdit", "Order API", "Order rules"]
}
```

修改后重新分析：

```json
{
  "actual": ["OrderStore", "OrderEdit", "Order API", "Order rules"],
  "missed": [],
  "unexpected": []
}
```

长期统计预测准确率，用于优化分析器和提示策略。

---

## 10. 分析器演进路线

### 10.1 第一阶段：保留现有启发式分析

现有正则分析器仍然有价值，用于快速发现候选：

- Vue 模板条件；
- Store 状态赋值；
- API 调用；
- 简单校验异常；
- 组件 import。

但所有结果必须保留低置信度和证据。

### 10.2 第二阶段：升级为 AST 分析

重点分析：

- import/export 图；
- 函数调用图；
- 状态读写；
- 条件表达式；
- computed/watch；
- API 参数和返回值；
- Vue 模板绑定；
- TypeScript 类型变化；
- JSX/React Hooks。

### 10.3 第三阶段：加入测试和 schema 证据

读取和关联：

- 单元测试；
- E2E 测试；
- 类型检查结果；
- lint 结果；
- OpenAPI；
- GraphQL schema；
- 数据库 schema；
- mock 数据和 fixture。

### 10.4 第四阶段：可选运行时证据

可接入：

- API 请求链路；
- Store 状态变化；
- 用户操作事件；
- 前端异常；
- 测试执行路径；
- 页面访问和权限结果。

静态分析回答：

```text
可能影响什么？
```

运行时证据回答：

```text
实际发生了什么？
```

---

## 11. LLM 使用原则

LLM 不应替代静态分析，而应负责归纳、消歧和解释。

### 11.1 适合交给 LLM

- 合并多个代码证据；
- 将代码条件翻译为业务语言；
- 判断两个实体是否可能是同一业务对象；
- 解释影响链；
- 从任务描述中提取业务事实；
- 从任务历史中提取开发经验；
- 识别规则冲突；
- 生成需要人工确认的问题。

### 11.2 不应直接交给 LLM

- 单独确认业务规则；
- 无证据覆盖知识；
- 仅凭文件名判断影响；
- 自动删除旧规则；
- 将推断直接写入 confirmed 知识。

### 11.3 LLM 输出格式

```json
{
  "claim": "审核中的订单不能修改核心险种",
  "confidence": 0.82,
  "evidence": [
    {
      "file": "src/stores/orderStore.ts",
      "line": 42,
      "snippet": "if (order.status === 'AUDIT') throw ..."
    }
  ],
  "reasoning": "前端 Store 和后端服务均存在相同限制",
  "questions": ["是否所有审核状态订单都不能修改？", "管理员是否有例外权限？"],
  "status": "candidate"
}
```

---

## 12. 任务经验和长期记忆

任务历史不能只作为 Markdown 日志，还要结构化保存。

### 12.1 任务记录

```ts
interface TaskExperience {
  taskId: string;
  summary: string;
  intent: string;
  changedFiles: string[];
  diffSummary: string[];
  affectedEntities: string[];
  affectedRules: string[];
  affectedApis: string[];
  predictedImpact: string[];
  actualImpact: string[];
  testsRun: TestResult[];
  lessons: string[];
  learnedFacts: string[];
  humanCorrections: string[];
  createdAt: string;
}
```

### 12.2 可复用经验

例如记录：

```text
过去修改 Order.status 时，通常需要同步修改：
- OrderStore；
- OrderEdit.vue；
- 后端 OrderService；
- 订单状态测试；
- 审核权限测试。
```

下一次 Agent 遇到类似任务时，自动召回该经验。

### 12.3 检索策略

初期不必立即引入向量数据库，可按以下顺序实现：

1. 关键词和实体名检索；
2. 关系图邻居检索；
3. 规则和 API 路径检索；
4. 历史任务相似度检索；
5. 再考虑 embedding 和向量数据库。

---

## 13. 实施优先级

### P0：形成自动闭环

1. 增加 Agent 生命周期 API；
2. 自动执行任务前 context；
3. 自动执行修改前 impact；
4. 自动捕获 after-edit diff；
5. 自动记录测试和类型检查结果；
6. 自动生成任务历史；
7. 自动提取业务事实候选；
8. 所有新知识默认进入候选队列。

验收标准：

- Agent 不需要手工记住每个命令；
- 每个任务都能生成完整任务记录；
- 每个候选知识都有证据和来源；
- 任务结束后可以看到新知识和影响链。

### P1：提升前端业务理解

1. 区分领域实体、Store、Composable、页面、组件和 API；
2. 增加页面模型；
3. 增加用户动作模型；
4. 增加状态机模型；
5. 建立页面—动作—Store—API—实体链路；
6. 增加 React/JSX/Hook 基础支持；
7. 增加权限和表单校验分析。

验收标准：

- 能描述一个前端业务流程；
- 能从页面动作追踪到 Store 和 API；
- 能从状态变化找到页面和测试；
- 能识别主要前端业务规则。

### P2：实现 Diff 级影响分析

1. 解析字段变化；
2. 解析状态变化；
3. 解析 API 变化；
4. 解析权限和校验变化；
5. 关联测试变化；
6. 生成预测影响和实际影响对比；
7. 统计影响预测准确率。

验收标准：

- 不只报告“文件受影响”；
- 能说明“哪个业务概念发生了什么变化”；
- 能列出需要检查的页面、接口、规则和测试。

### P3：知识质量和长期记忆

1. 增加知识版本；
2. 增加 stale/contradicted 状态；
3. 增加证据行级校验；
4. 增加规则冲突解释；
5. 增加相似任务召回；
6. 增加人工反馈对置信度的影响；
7. 支持分支和多人协作下的知识合并。

验收标准：

- 旧知识不会静默失效；
- 冲突知识可追踪；
- Agent 能参考过去类似任务；
- 人工修正可以持续改善后续判断。

---

## 14. 推荐新增命令

```text
business-agent task start "修改订单审核流程"
business-agent task context
business-agent task predict-impact
business-agent task checkpoint
business-agent task test
business-agent task finish
business-agent task review
```

也可以保留现有命令作为底层能力：

```text
discover
context
impact
capture
learn
review
promote
validate
```

推荐关系：

```text
task start       = context + session
predict-impact   = context + impact + risk analysis
checkpoint       = diff + impact + observation
finish           = capture + learn + validation
review           = candidate review + conflict resolution
```

---

## 15. 推荐测试体系

### 15.1 知识测试

- 新规则是否进入 candidate；
- 人工确认后是否进入 confirmed；
- 证据消失后是否变成 stale；
- 新旧规则冲突时是否进入 contradicted；
- 知识版本是否保留。

### 15.2 前端分析测试

- Vue 页面、Store、Composable、API wrapper 链路；
- 状态读写和状态转换；
- `v-if`、`:disabled`、表单校验；
- React JSX 和 Hooks；
- 路由权限；
- API 参数和返回类型。

### 15.3 Diff 影响测试

- 新增字段；
- 删除字段；
- 修改状态值；
- 修改 API 路径；
- 修改权限判断；
- 修改表单校验；
- 预测影响和实际影响对比。

### 15.4 任务闭环测试

- `before_task` 是否召回上下文；
- `before_edit` 是否生成影响预测；
- `after_edit` 是否捕获 diff；
- `after_test` 是否记录测试结果；
- `after_task` 是否生成知识候选；
- Agent 中断后是否可以恢复任务状态。

### 15.5 质量门禁

每次提交或发布前执行：

```bash
npm run check
npm run lint
npm run format:check
npm test
npm run build
```

---

## 16. 不建议优先做的事情

不要优先投入以下工作：

- 继续堆叠大量正则 analyzer；
- 让 LLM 无证据生成 confirmed 规则；
- 只增加更多 Markdown 模板；
- 只扩大扫描文件数量；
- 只做更多静态实体名称匹配；
- 在没有生命周期接入前继续增加独立 CLI 命令。

优先级应该是：

```text
生命周期接入
  > 结构化知识模型
  > Diff 级影响分析
  > 前端状态和流程模型
  > 知识质量控制
  > 更复杂的 LLM 和向量检索
```

---

## 17. 最终验收标准

当以下问题都能稳定回答时，插件才可以认为基本达到目标：

### 项目理解

- 项目有哪些核心业务对象？
- 每个业务对象有哪些字段和状态？
- 哪些页面、Store、API 和数据库表与其相关？
- 哪些对象之间存在业务关系？

### 业务理解

- 业务对象有哪些状态？
- 状态如何转换？
- 哪些条件是业务规则？
- 哪些规则已经确认，哪些只是推断？
- 哪些规则存在冲突或已经过期？

### 变更影响

- 当前修改涉及哪个业务概念？
- 修改了字段、状态、API、权限还是校验？
- 会影响哪些页面、Store、API、后端服务和测试？
- 哪些影响是确定的，哪些只是可能的？
- 是否违反了已确认业务规则？

### 持续学习

- 本次任务学到了什么？
- 新知识的证据是什么？
- 是否有人工确认？
- 后续类似任务能否召回本次经验？
- 旧知识是否因本次修改而过期或冲突？

---

## 18. 总结

插件的优化方向不是简单增加扫描规则，而是完成以下四个升级：

```text
从 CLI 工具
  -> Agent 生命周期组件

从文件知识库
  -> 带证据、版本和状态的结构化知识系统

从文件级关联
  -> Diff 级业务影响分析

从技术依赖图
  -> 前端页面、动作、状态、流程和业务规则模型
```

最重要的第一步是实现 P0：

```text
任务自动接入
  -> 自动召回上下文
  -> 自动预测影响
  -> 自动捕获变更
  -> 自动验证
  -> 自动沉淀候选知识
```

完成这一步后，插件才会从“需要 Agent 主动调用的辅助工具”，逐步成为“Agent 工作过程中持续积累项目理解的基础设施”。
