# Business Agent 插件差距分析与优化建议

> 对照四条核心需求：1) 懂业务对象；2) 懂业务关系；3) 懂业务规则；4) 知道改一处影响什么。
> 分析基于当前代码库（src/core、src/commands、schemas、tests）的实际实现，不基于文档宣称。

---

> **📌 文档状态（2026-08-29 刷新）**
>
> 本文原为实施前的差距分析。第 6 节的 **P0 / P1 / P2 共 15 项优化建议已全部实施完成**，
> 第 2-5 节列出的 **22 条差距中 19 条已闭环、3 条部分闭环**。
>
> - 第 1 节评分、第 8 节验收标准：已按现状重写
> - 第 2-5 节：每条差距新增「状态」列，标注闭环方式与代码落点
> - 第 9 节：实施提示词保留作历史记录，均已执行完毕
>
> 图例：✅ 已闭环 ｜ 🟡 部分闭环 ｜ ⚪ 未处理（本文已无此项）

---

## 1. 总体评估矩阵

| 需求          | 实施前       | 当前完成度       | 一句话结论                                                                                   |
| ------------- | ------------ | ---------------- | -------------------------------------------------------------------------------------------- |
| 1. 懂业务对象 | ★★★☆☆（60%） | ★★★★☆（**85%**） | 别名归并、glossary、生命周期回链、带证据的描述全部接通；业务语言仍依赖默认关闭的 LLM         |
| 2. 懂业务关系 | ★★★★☆（70%） | ★★★★☆（**85%**） | 节点身份稳定、关系本体受控、mermaid 可视化、跨仓链路齐全；共现窗口产生的假关系只降权未消源头 |
| 3. 懂业务规则 | ★★★☆☆（55%） | ★★★★☆（**80%**） | 提取覆盖面、规则↔测试、语义冲突、自动保鲜、违反判定均已落地；规则描述仍偏代码味              |
| 4. 影响分析   | ★★★★☆（75%） | ★★★★★（**90%**） | 字段级传播、契约对账、深度自适应、证据违反判定齐全；历史准确率只用于降权，未参与排序         |

**整体判断：** 项目已从「缺功能」阶段进入「调精度」阶段。剩余三项（G2.3、G4.6、G3.2）有一个共同点——它们都不是纯静态分析能闭环的：要么需要更保守的默认策略，要么需要 LLM 参与语义理解。

**当前门禁状态**：`npm run check` / `npm run lint` / `npm run format:check` 三项全绿；vitest 35 个文件、225 个用例全部通过。
（注：Windows 环境下 vitest 跑完测试后进程不退出，属 vitest 4.1.10 + Node 22 的子进程回收问题，与项目代码无关，CI 里需包一层 `timeout`。）

---

## 2. 需求一：懂业务对象 —— 差距分析

### 2.1 已具备

- 类型体系完整：`EntityType` 已区分 `business_entity / frontend_store / composable / page / component / api_client / backend_api / database_table`（src/core/types.ts）。
- 实体属性提取：TS AST（interface/class）、JPA `@Column`、MyBatis resultMap、Pinia state/ref、Go struct、Python dataclass 均产出 attributes。
- 检索支持中文：retrieval.ts 对 CJK 做 bigram 切分，中文业务术语可召回。
- 知识分层：entity markdown 人工编辑在 discover 重跑时保留。

### 2.2 差距与当前状态

| #    | 差距（原始发现）                                                                        | 状态      | 闭环方式 / 落点                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1.1 | **默认 discover 近乎裸奔**——不加 `--deep` 时只跑正则匹配，新用户得到近似空的知识库      | ✅ 已闭环 | P0-3：`DEFAULT_CONFIG.analyzers` 改为 `['sql','api','ast']`（`src/core/config.ts`），保留用户显式配置 `[]` 可全关的语义                                    |
| G1.2 | **实体描述是模板句**——默认 `"Discovered business candidate: X"`，没有证据、没有业务含义 | ✅ 已闭环 | 新增 `src/core/entity-description.ts`，生成带证据文件的描述（最多列 3 个证据文件）；旧前缀仍被识别，存量知识不失效。_注：真正的业务语言仍需 LLM_           |
| G1.3 | **无实体消歧/归并**——`orders` 表、`Order` 实体、`OrderDTO`、`orderStore` 被当成不同对象 | ✅ 已闭环 | P0-2：`src/core/glossary.ts` 的 `buildAliasIndex` 产出全局别名表，`mergeEntitiesByAlias` 归并同义实体（attributes/evidence 并集、confidence 取高）         |
| G1.4 | **glossary.md 是死模板**——`src/` 中零处引用，业务术语未接入任何链路                     | ✅ 已闭环 | P0-2：glossary 结构化表格 → `aliasIndex` → discovery / retrieval / context / impact 全线查询前先过别名表                                                   |
| G1.5 | **实体与状态机/工作流松耦合**——entity 上没有状态回链，context 靠实体名匹配拼在一起      | ✅ 已闭环 | `Entity` 新增可选 `states?: string[]`；`discovery.ts` 的 `attachEntityStates()` 按别名归一回写；`context.ts` 改读该字段；实体 markdown 增加 `## States` 段 |

---

## 3. 需求二：懂业务关系 —— 差距分析

### 3.1 已具备

- 关系来源多样：SQL REFERENCES/JOIN、AST 类型引用、Vue 组件 import、Store/Composable 引用、JPA `@ManyToOne`、MyBatis `<association>`、linkage 跨端匹配、OpenAPI 契约。
- 双向图 + BFS：`buildGraph`/`traceChain` 双向遍历，深度可配置。
- 依赖相位化执行：entity producer → dependent → linkage → contract。

### 3.2 差距与当前状态

| #    | 差距（原始发现）                                                                              | 状态        | 闭环方式 / 落点                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G2.1 | **图节点身份 = PascalCase 文件名**——重命名、命名风格混用、同名不同目录都会断链或误连          | ✅ 已闭环   | P0-1：`src/core/module-id.ts` 的 `moduleNodeId()` 用「相对路径小写 + `module:` 前缀」做节点 ID，Pascal 名退化为显示名；旧 manifest 缺失 `modules` 时回退并告警             |
| G2.2 | **无统一关系本体**——relationship 是自由字符串，无法区分强弱耦合                               | ✅ 已闭环   | P1-2：`schemas/relation.schema.json` 收敛为 `owns / aggregates / references / calls / renders / maps-to`；`types.ts` 有旧值迁移映射，不重写用户已有知识文件                |
| G2.3 | **默认引擎的关系是噪声**——150 字符窗口内实体名共现就生成 `references_or_contains` 的 low 关系 | 🟡 部分闭环 | 保留窗口机制（`config.relationWindow` 仍为 150），但 `loadLowAccuracyRelationships()` 会把历史命中率为零的边降权（排序后置）。**噪声源头未消除**，中大型仓库仍会产生假关系 |
| G2.4 | **无关系图可视化**——关系图和 impact 只有文本列表                                              | ✅ 已闭环   | P1-5：`src/core/graph.ts` 抽出 `buildGraph` 与 `renderMermaidSubgraph`；`context` 输出邻域 mermaid，`impactMarkdown` 输出 `## Impact Graph` 并高亮变更模块，超 40 节点截断 |
| G2.5 | **cardinality 大多 unknown**——只有 SQL FK 和 JPA 注解给出基数                                 | ✅ 已闭环   | P1-2：`src/core/analyzers/ast.ts` 的 `typeCardinality()` 按类型引用形态推断（数组/`Promise<T[]>` → `N:1`，单引用 → `1:1`）                                                 |
| G2.6 | **无跨服务/跨仓库边界**——前后端分仓时 linkage 直接失效                                        | ✅ 已闭环   | P2-e：`config.linkage.externalApis` 支持引入其它仓库导出的 manifest，`linkFrontendModules` 合并外部 API 后再建链，缺失/损坏只告警                                          |

---

## 4. 需求三：懂业务规则 —— 差距分析

### 4.1 已具备

- 完整生命周期：candidate → review → promote（schema 校验 + impact map）→ conflicts → deprecate；knowledge-state 有 verified/stale/contradicted 状态机。
- llm-rules 分析器可把代码条件翻译成业务语言（默认关闭、片段上传需显式开启、有脱敏）。

### 4.2 差距与当前状态

| #    | 差距（原始发现）                                                                                    | 状态        | 闭环方式 / 落点                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3.1 | **提取模式覆盖面窄**——只有 3 个正则，校验注解、SQL CHECK、错误码、自定义异常、computed 判断全部漏掉 | ✅ 已闭环   | P1-3：`java.ts` 支持 `@NotNull/@NotBlank/@NotEmpty/@Size/@Min/@Max/@Valid` 与 `@PreAuthorize/@PreFilter`；`parse.ts` 支持 SQL `CHECK`；`discovery.ts` 支持 `throw new \w*(Business\|Service\|Biz)\w*Exception`；`stores.ts` 支持 `const canXxx = computed(...)`。新候选一律 low confidence，不自动 promote |
| G3.2 | **规则不会说业务话**——候选规则是代码语句直译，entity 常为 `Unknown`                                 | 🟡 部分闭环 | 规则实体归属已通过别名表改善（`Unknown` 大幅减少），但**业务语言归纳仍依赖默认关闭的 llm-rules 分析器**。保守策略是有意为之：宁可给代码味描述，也不臆测业务含义                                                                                                                                            |
| G3.3 | **规则与测试无关联**——无法指出「这条规则失去测试保护了」                                            | ✅ 已闭环   | P1-4：`BusinessRule.coveringTests`；discover 按「测试路径含实体名或别名」+「测试内容含证据片段/状态字面量」登记；impact 报告新增 `## Test Coverage` 节，分「有测试保护 / 无测试保护（建议补测试）」两组                                                                                                    |
| G3.4 | **规则新鲜度不自动刷新**——知识库静默腐烂                                                            | ✅ 已闭环   | P2-c：post-commit hook 调 `capture --refresh-knowledge`，对变更文件做增量 re-discover + `validateEvidence`，失效率效规则自动标 stale；刷新记录写入 `.agent/memory/hook-refresh.log`（JSONL，上限 200 行）；capture 总耗时超 10s 则跳过增量发现，避免拖慢 commit                                            |
| G3.5 | **规则冲突只有文本级**——检测不到「审核中不能改」vs「管理员随时能改」这类条件性冲突                  | ✅ 已闭环   | P2-d：`src/core/conflicts.ts` 新增前置条件维度检测，同主语/谓语对立但 preconditions 不同 → 判定为「条件性冲突」，建议「确认两者前置条件是否互斥」                                                                                                                                                          |

---

## 5. 需求四：修改一处知道影响什么 —— 差距分析

### 5.1 已具备（当前最强项）

- 文件 → 关系图双向 BFS → 实体/规则/关系/API/页面/动作/工作流/测试。
- diff 级 15 类变更识别（字段增删改类型、状态变化、API 路径/方法、请求/响应类型、权限、校验、库字段、测试）。
- `task predict-impact` vs `checkpoint` 预测/实际对比，跨任务准确率统计。
- deriveRisks 输出人类可读风险提示。

### 5.2 差距与当前状态

| #    | 差距（原始发现）                                                          | 状态        | 闭环方式 / 落点                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G4.1 | **diff→影响的映射靠字符串 token 匹配**——`status` 会命中一大片，改名则断链 | ✅ 已闭环   | P1-1：`manifest.fieldIndex`（key 为 `entity.field` 小写）精确匹配优先，`matchesFinding` 字符串匹配降级为兜底                                                                                                                       |
| G4.2 | **无字段级影响传播**——影响链仍以实体/文件为粒度                           | ✅ 已闭环   | P1-1：fieldIndex 登记 `entity.field → {apis, stores, pages, tests, evidence}`；命中时输出链式传播行（如 `Order.status → GET /api/orders → orderStore → OrderEdit.vue → order-edit.spec.ts`）                                       |
| G4.3 | **遍历深度硬编码 3**——真实项目 5-6 跳的下游全漏                           | ✅ 已闭环   | P2-b：`config.impact.maxDepth` 默认放宽到 6；`traceChain` 增加终止节点剪枝（到达页面/测试/API 等终态且深度足够时停止），避免爆炸                                                                                                   |
| G4.4 | **无契约级对账**——改了后端响应结构，前端是否同步只能靠猜                  | ✅ 已闭环   | P2-a：`src/core/analyzers/openapi.ts` 导入 openapi.json/yaml，`buildContractDrift()` 在 diff 中输出「契约漂移」风险提示                                                                                                            |
| G4.5 | **不检查「是否违反已确认规则」**——删了证据行却不判定规则被违反            | ✅ 已闭环   | P0-4：`detectRuleViolations()` 对证据文件在本次变更范围内的 confirmed 规则逐条 `validateEvidence`；文件消失 → `confirmed-missing`，行越界/snippet 丢失/hash 变化 → `likely-modified`；结果进 `## Rule Violations` 节并置顶到 risks |
| G4.6 | **准确率不反哺**——impact-accuracy.json 统计了命中率却没被使用             | 🟡 部分闭环 | P2-b：`loadLowAccuracyRelationships()` 读取历史准确率，对命中率为零的边类型降权（排序后置、不删除）。**未参与排序打分与置信度计算**，仍是纯静态启发式                                                                              |

---

## 6. 优化建议（按优先级）

> 状态：以下 15 项**全部已完成**并合并入 main。

### P0 —— 修地基

| 项                                | 目标       | 状态                                 |
| --------------------------------- | ---------- | ------------------------------------ |
| **P0-1** 稳定图节点身份           | G2.1       | ✅ 已完成 —— `src/core/module-id.ts` |
| **P0-2** 实体归并与 glossary 接线 | G1.3、G1.4 | ✅ 已完成 —— `src/core/glossary.ts`  |
| **P0-3** 默认 discover 不再裸奔   | G1.1       | ✅ 已完成 —— `src/core/config.ts`    |
| **P0-4** impact 接入证据校验      | G4.5       | ✅ 已完成 —— `src/core/impact.ts`    |

### P1 —— 提精度

| 项                              | 目标       | 状态                                           |
| ------------------------------- | ---------- | ---------------------------------------------- |
| **P1-1** 字段级影响传播         | G4.1、G4.2 | ✅ 已完成 —— `manifest.fieldIndex`             |
| **P1-2** 关系本体 + cardinality | G2.2、G2.5 | ✅ 已完成 —— schema 枚举 + `ast.ts`            |
| **P1-3** 规则提取扩容           | G3.1       | ✅ 已完成 —— java / parse / stores / discovery |
| **P1-4** 规则↔测试关联          | G3.3       | ✅ 已完成 —— `coveringTests`                   |
| **P1-5** 关系图 mermaid 可视化  | G2.4       | ✅ 已完成 —— `src/core/graph.ts`               |

### P2 —— 补场景

| 项                   | 目标       | 状态                                        |
| -------------------- | ---------- | ------------------------------------------- |
| **OpenAPI 契约对账** | G4.4       | ✅ 已完成                                   |
| **影响深度自适应**   | G4.3、G4.6 | ✅ 已完成（G4.6 仅部分）                    |
| **知识自动保鲜**     | G3.4       | ✅ 已完成                                   |
| **语义级规则冲突**   | G3.5       | ✅ 已完成                                   |
| **多仓库 linkage**   | G2.6       | ✅ 已完成                                   |
| **Go/Python 分析器** | —          | ✅ 已完成 —— `analyzers/go.ts`、`python.ts` |

### 不建议现在做（维持原判断）

- 向量检索/embedding：词法 + 别名表 + 图扩展在当前数据量下够用；
- 运行时证据采集（埋点/APM）：静态精度不足时收益低；
- 自动流程（workflow）推理：维持人工模板 + 状态机自动提取；
- 把 `--deep` 全家桶设为默认：只提 sql/api/ast。

---

## 7. 实施顺序（回顾）

```text
已完成（全部落地）
  第 1 批：P0-1 / P0-2 / P0-3 / P0-4
  第 2 批：P1-1 / P1-2 / P1-3 / P1-4 / P1-5
  第 3 批：P2-a OpenAPI / P2-b 深度自适应 / P2-c 知识保鲜
           / P2-d 语义冲突 / P2-e 多仓 linkage / P2-f Go+Python
  收尾：G1.2 实体描述去模板化、G1.5 实体↔状态机回链
```

---

## 8. 验收标准（对照四条需求，按现状重写）

- **懂业务对象**：`context 缴费`（中文业务词）经别名表命中 `PremiumPayment` 实体，输出中英文别名、
  生命周期状态、涉及页面/表/接口；`orders` 表、`OrderDTO`、`orderStore` 归并为同一节点；
  实体描述至少带出它是在哪些文件里被发现的。
- **懂业务关系**：任一实体可输出带 cardinality 的 mermaid 邻域图；文件重命名后链路不断；
  前后端分仓时通过 `linkage.externalApis` 仍能连通。
- **懂业务规则**：删除某规则的证据代码行后，impact 直接报 `## Rule Violations` 并指出哪些规则失去测试保护；
  语义冲突能识别「审核中不能改」与「管理员随时能改」的差异。
  _（规则描述的业务化程度取决于是否开启 llm-rules，默认关闭时仍是代码味描述。）_
- **影响分析**：改一个 SQL 字段，报告能列出「表 → 实体 → API → Store → 页面 → 测试」全链路且每环有证据行号；
  深度超过 3 跳的下游不再漏报；与 OpenAPI 契约不一致时给出漂移提示。
  _（预测准确率目前只用于给零命中的边降权，尚未参与排序打分。）_

---

## 9. 实施方法与执行提示词（历史记录）

> ⚠️ 本节为实施前的派发材料，**全部任务已执行完毕**，保留作历史记录与回归参考。
> 如需重新实现同类能力，可复用其中的约束与验收要求。
>
> **通用项目约束**：TypeScript strict、零新增运行时依赖、vitest 测试、注释用英文与现有代码一致、
> 静态分析只产候选（low/medium 置信度）、失败只告警不中断、
> 每项完成后必须通过 `npm run check && npm run lint && npm run format:check && npm test`。

### 9.1 P0-1 稳定图节点身份

**实施方法**

1. `src/core/types.ts`：`DiscoverManifest` 增加 `modules?: Array<{ id: string; path: string; name: string }>`——`id` 为相对路径去扩展名、小写、正斜杠；`name` 为现有 Pascal 显示名。
2. `src/core/analyzers/linkage.ts`：新增导出 `moduleNodeId(file: string): string`；文件内建边逻辑全部改用 `moduleNodeId`，`fileModuleName` 保留仅作显示名（其它文件仍在 import 它，不要删除导出）。
3. discover 落盘 manifest 时写入 `modules` 映射（来源：scan 样本文件 + 各 analyzer evidence 中出现的文件）。
4. `src/core/impact.ts`：`buildGraph`/`traceChain` 的节点键改为 `moduleNodeId`；读取旧 manifest（无 `modules` 字段）时回退 `fileModuleName` 并 push warning `'Legacy manifest: node identity may be unstable; re-run discover.'`。
5. 实体节点仍用实体名（entity 节点与 module 节点是两类节点，靠现有 relation 连接，不合并）。
6. 测试：新增 `tests/module-id.test.ts`（同名不同目录、kebab/Pascal 混用、文件重命名后链路不断）；更新 `tests/linkage.test.ts`、`tests/impact.test.ts` 中因节点 ID 变化而失效的断言。

**实际落点差异**：实现最终抽到了独立的 `src/core/module-id.ts`（而非放在 linkage.ts），
测试覆盖落在 `tests/full.test.ts`、`tests/impact.test.ts`、`tests/linkage.test.ts`，未单独建 module-id.test.ts。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest，零运行时依赖原则，业务知识工具 CLI）的编码 Agent。任务：稳定关系图的节点身份。

背景：src/core/analyzers/linkage.ts 的 fileModuleName() 用文件名推导 PascalCase 作为图节点身份，文件重命名或 kebab/Pascal 命名混用会导致关系图断链或误连，进而破坏 impact 影响分析。

要求：
1. src/core/types.ts：DiscoverManifest 增加 modules?: Array<{ id: string; path: string; name: string }>，id = 文件相对路径去扩展名、统一小写、正斜杠；name = 现有 PascalCase 显示名。
2. src/core/analyzers/linkage.ts：新增导出 moduleNodeId(file: string): string 按上述规则生成节点 ID；该文件内所有建边改用 moduleNodeId；fileModuleName 保留导出（其它模块还在用），仅作显示名。
3. discover 流程（src/core/discovery.ts 与 src/core/analyzer.ts）把 modules 映射写入 discovery-manifest.json。
4. src/core/impact.ts：buildGraph/traceChain 节点键改用 moduleNodeId；读取无 modules 字段的旧 manifest 时回退 fileModuleName，并在 report.warnings 追加一条提示。
5. 实体节点身份保持实体名不变，不与模块节点合并。
6. 新增 tests/module-id.test.ts，覆盖：同名文件不同目录不冲突、kebab-case 与 PascalCase 文件指向同一节点、文件重命名后 impact 链路不断（可改造现有 fixture 验证）。

约束：不新增任何 npm 依赖；注释用英文、风格与现有代码一致；解析失败只告警不抛异常。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿；在结果说明中列出因节点 ID 变化而更新的既有断言清单。
```

### 9.2 P0-2 实体归并与 glossary 接线

**实施方法**

1. 更新模板 `templates/agent/business/glossary.md` 为结构化表格（三列表头固定）：

   ```markdown
   | 术语 | 别名                            | 实体  |
   | ---- | ------------------------------- | ----- |
   | 缴费 | PremiumPayment, premium_payment | Order |
   ```

2. 新增 `src/core/glossary.ts`：
   - `loadGlossary(root)`：解析 glossary.md 表格 → `GlossaryEntry { term; aliases[]; entity }`；
   - `buildAliasIndex(entities, glossary)`：返回 `Record<string, string>`（别名小写 → 实体名），自动补充：单复数、剥离 `DTO/Vo/VO/BO/PO` 后缀、snake_case↔PascalCase、表名复数（吸收 `impact.ts` 中 `buildEntityTableAliases` 的规则并删除该局部函数）。
3. `src/core/discovery.ts`：manifest 增加 `aliases?: Record<string, string>`；把别名指向同一实体的重复实体节点合并（attributes/evidence 取并集，confidence 取最高，人工编辑过的 entity markdown 不覆盖）。
4. `src/core/retrieval.ts`：构建索引时把别名注入 `tokens` 与 `aliases` 字段。
5. `src/commands/context.ts`：subject 匹配实体前先过别名表归一（`缴费` → `Order`）。
6. `src/core/impact.ts`：表名→实体推断改读 manifest.aliases。
7. 测试：新增 `tests/glossary.test.ts`；fixtures 增加 glossary 表格与中文术语命中用例。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest，零运行时依赖）的编码 Agent。任务：实现业务术语表（glossary）与实体别名归并。

背景：templates/agent/business/glossary.md 目前是死模板，代码中零引用；实体识别不消歧（orders 表、Order 实体、OrderDTO、orderStore 被当成不同对象），导致关系图出现重复节点、中文业务词无法命中实体。

要求：
1. 把 glossary.md 模板更新为结构化 markdown 表格（表头：| 术语 | 别名 | 实体 |），附两行示例。
2. 新增 src/core/glossary.ts：loadGlossary(root) 解析该表格；buildAliasIndex(entities, glossary) 生成 别名小写→实体名 的映射，自动补充单复数、DTO/Vo/VO/BO/PO 后缀剥离、snake_case/PascalCase 互转、表名复数规则（参考并最终替代 src/core/impact.ts 里的 buildEntityTableAliases）。
3. src/core/discovery.ts：manifest 增加 aliases 字段落盘；合并指向同一实体的重复实体节点（attributes/evidence 并集、confidence 取最高、人工编辑过的 entity markdown 不覆盖——现有 discover 已有保留逻辑，不要破坏）。
4. src/core/retrieval.ts：索引文档的 tokens 与 aliases 注入别名。
5. src/commands/context.ts：subject 匹配前先经别名表归一，使中文术语（如“缴费”）能命中实体。
6. src/core/impact.ts：表名→实体推断改读 manifest.aliases。
7. 新增 tests/glossary.test.ts：表格解析、别名归并、中文术语 context 命中、orders 表名映射到 Order 实体。

约束：不新增依赖；表格解析失败时静默返回空表并告警一次；保守合并——只归并别名明确指向同一实体的节点。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿；演示 tests/fixtures 下新增用例：context “缴费” 能召回 Order 实体及其关系。
```

### 9.3 P0-3 默认 discover 不再裸奔

**实施方法**

1. `src/core/config.ts`：`DEFAULT_CONFIG.analyzers` 由 `[]` 改为 `['sql', 'api', 'ast']`。注意 `mergeConfig` 数组语义是整体替换——用户显式写 `"analyzers": []` 即关闭全部（保留该语义，README 说明）。
2. 检查 `src/commands/discover.ts` 与 `src/core/analyzer.ts` 的 `resolveAnalyzers`：`--deep` 仍代表全集；配置显式非空时以配置为准（只改默认值，不改优先级逻辑）。
3. ast 分析器在无 typescript 运行时依赖时已有降级告警——确认默认开启后告警文案可行动（提示安装 typescript 或说明可忽略）。
4. README 快速开始改为 `business-agent discover`（不带 --deep 即有基础产出），配置表 `analyzers` 默认值同步更新。
5. 更新 `tests/config.test.ts`、`tests/commands.test.ts` 的默认值断言。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：把 sql/api/ast 三个分析器设为 discover 的默认开启。

背景：src/core/config.ts 的 DEFAULT_CONFIG.analyzers 默认是空数组，用户不带 --deep 跑 discover 得到的几乎是空知识库。

要求：
1. DEFAULT_CONFIG.analyzers 改为 ['sql', 'api', 'ast']。保留 mergeConfig 的数组整体替换语义（用户显式配 "analyzers": [] 可全部关闭）。
2. 阅读 src/commands/discover.ts 与 src/core/analyzer.ts 的 resolveAnalyzers，确认 --deep 与显式配置的优先级逻辑不变，只改默认值。
3. ast 分析器在运行时找不到 typescript 时的降级告警文案要可行动（说明安装方式或可忽略）。
4. README：快速开始去掉 --deep（基础产出已默认）、配置表 analyzers 默认值改为 ['sql','api','ast'] 并说明关闭方式。
5. 更新 tests/config.test.ts、tests/commands.test.ts 中默认值相关断言。

约束：不新增依赖；java/xml/vue/stores/frontend/linkage/llm 系列仍保持非默认。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿；新 fixture 项目跑 discover（不带 --deep）能产出 SQL 实体、API 路由和 AST 类型引用。
```

### 9.4 P0-4 impact 接入证据校验，判定“规则被违反”

**实施方法**

1. `src/core/types.ts`：`ImpactReport` 增加
   `violations: Array<{ ruleId: string; ruleName: string; evidence: string; reason: string; severity: 'confirmed-missing' | 'likely-modified' }>`。
2. `src/core/impact.ts` 的 `buildImpactReport`：对 `loadRules` 得到的 confirmed 规则中 evidence 文件 ∈ changedFiles 的每条规则，先 `normalizeEvidence(rule.evidence)`（`src/core/evidence.ts` 已支持 `"file:line"` 字符串解析），再逐条 `validateEvidence(ref, root)`：
   - 文件不存在 → `confirmed-missing`；
   - 行越界 / snippet 不在文件中 / contentHash 变化 → `likely-modified`；
   - 旧证据无 contentHash 时只做文件存在 + 行范围判断，不误报。
3. `impactMarkdown` 新增 `## Rule Violations` 节（置于 Risks 之前）；violations 同步插入 risks 首位；`--json` 输出透传该字段。
4. 测试：`tests/impact.test.ts` 新增 fixture——修改规则证据行 / 删除证据文件 → 断言 violations 与 markdown 输出。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：让 impact 报告能判定“本次改动违反了哪条已确认业务规则”。

背景：src/core/impact.ts 的 buildImpactReport 只输出“涉及 N 条相关规则”的模板句；而 src/core/evidence.ts 已有 normalizeEvidence（支持 "file:line" 字符串）和 validateEvidence（校验文件存在、行范围、snippet、contentHash），但没有接进 impact。规则对象的 evidence 是 string[]（形如 "src/order.ts:42"）。

要求：
1. src/core/types.ts：ImpactReport 增加 violations 字段：Array<{ ruleId, ruleName, evidence, reason, severity: 'confirmed-missing' | 'likely-modified' }>。
2. src/core/impact.ts：对 loadRules 加载的 confirmed 规则中、evidence 文件出现在本次 changedFiles 里的每条规则：normalizeEvidence 后逐条 validateEvidence(ref, root)。文件不存在 → confirmed-missing；行越界/snippet 丢失/contentHash 变化 → likely-modified。旧证据没有 contentHash 时只做存在性+行范围校验，避免误报。
3. impactMarkdown 增加 "## Rule Violations" 节（在 Risks 之前），每条格式：`- [severity] ruleId (ruleName): evidence — reason`；同时把 violations 插入 risks 数组首位。--json 输出包含 violations。
4. tests/impact.test.ts 新增用例：a) 修改规则证据所在行 → likely-modified；b) 删除证据文件 → confirmed-missing；c) 与规则无关的改动不产生 violation。

约束：不新增依赖；校验 IO 失败只降级为 warning，不中断报告生成。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

### 9.5 P1-1 字段级影响传播

**实施方法**

1. `src/core/types.ts`：`DiscoverManifest` 增加
   `fieldIndex?: Record<string, { entity: string; apis: string[]; stores: string[]; pages: string[]; tests: string[] }>`，key 为 `${entity}.${field}` 全小写。
2. 登记来源（各 analyzer 产出时顺手登记，不新增扫描）：
   - **sql**：表列 → 实体字段（表名→实体名走 aliases/manifest.aliases，P0-2 已建）；
   - **ast**：interface/class 字段 → 实体；引用该类型的模块若被 stores/frontend 分析器归类为 store/page → 填 stores/pages；
   - **api**：route.entity 对应请求/响应类型中的字段 → apis 填 `${method} ${path}`；
   - **tests**：manifest.tests 中文件名含实体名（含别名）→ 填 tests。
3. `src/core/impact.ts` `mapDiffImpact`：finding.subject 先按 `entity.field`（或裸字段名 + 受影响实体限定）查 fieldIndex，精确命中直接返回结果；未命中再退回现有 `matchesFinding` 字符串匹配。
4. `impactMarkdown` 的 Diff To Impact 段升级：命中 fieldIndex 时输出链式传播行，如 `Order.status -> GET /api/orders -> orderStore -> OrderEdit.vue -> order-edit.spec.ts`。
5. 测试：在 `tests/full.test.ts` 或新 fixture 中验证“改字段 → 全链路命中”。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：实现字段级影响传播索引。

背景：src/core/impact.ts 的 mapDiffImpact 目前用 matchesFinding 做字符串 token 互相 includes 的启发式匹配，字段名（如 status）会误命中一大片，字段改名则断链。diff finding 已有 subject（如 "Order.status" 或字段名）。

要求：
1. src/core/types.ts：DiscoverManifest 增加 fieldIndex?: Record<string, { entity, apis: string[], stores: string[], pages: string[], tests: string[] }>，key 为 "entity.field" 全小写。
2. 在 sql / ast / api 分析器（src/core/analyzers/）产出实体属性或路由时登记索引：sql 表列→实体字段；ast 字段→实体，引用方模块属 store/page 时填 stores/pages；api 请求/响应类型字段→apis（格式 "METHOD /path"）；manifest.tests 中文件名含实体名（含别名表）→ tests。表名/别名归一依赖 manifest.aliases（若尚未落地请先用现有 buildEntityTableAliases 逻辑并在代码中留 TODO）。
3. src/core/impact.ts mapDiffImpact：finding.subject 先查 fieldIndex（支持 "Entity.field" 与裸字段名+受影响实体限定两种形式），命中则直接产出映射；未命中回退现有 matchesFinding。不要删除现有兜底逻辑。
4. impactMarkdown：Diff To Impact 段命中 fieldIndex 时输出链式行：Order.status -> GET /api/orders -> orderStore -> OrderEdit.vue -> order-edit.spec.ts。
5. 测试：新 fixture 验证改一个 SQL 字段能命中表→API→Store→页面→测试全链路；并保留至少一个只能靠 token 兜底命中的回归用例。

约束：不新增依赖；fieldIndex 为可选字段，旧 manifest 缺失时行为与现在完全一致。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

### 9.6 P1-2 关系本体受控词表 + cardinality 补全

**实施方法**

1. 先 grep 全部现役 relationship 值：`grep -rn "relationship:" src/core/analyzers/`，据此定迁移映射（预期包括 `references_or_contains → references`、`join → references`、`uses → calls`、`contains → aggregates` 等）。
2. `schemas/relation.schema.json`：relationship 收敛为枚举 `owns | aggregates | references | calls | renders | maps-to`。
3. 兼容：在 `knowledge.ts loadRelations` 与 manifest 读取处做内存映射迁移（旧值→新值），不重写用户已有知识文件。
4. `src/core/types.ts`：`Relation.relationship` 收紧为字面量联合（允许过渡期 string 兼容）。
5. `src/core/analyzers/ast.ts`：类型引用为数组类型 / `Promise<T[]>` → cardinality `N:1`，单引用 → `1:1`。
6. 测试：更新 relation 相关断言；新增旧值迁移用例。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：统一关系类型本体并补全 cardinality。

背景：Relation.relationship 目前是自由字符串（references_or_contains/join/uses 等混用），无法按语义区分强弱耦合；除 SQL/JPA 外 cardinality 几乎全部 unknown。

要求：
1. 先 grep src/core/analyzers/ 下所有 relationship 赋值，列出全部现役值。
2. schemas/relation.schema.json：relationship 改为枚举 owns | aggregates | references | calls | renders | maps-to。
3. 建立旧值→新值迁移映射（如 references_or_contains→references、join→references、uses→calls），在 src/core/knowledge.ts loadRelations 与 discovery manifest 读取处做内存迁移，不重写用户已落盘的知识文件。
4. src/core/types.ts：Relation.relationship 收紧为字面量联合，保留过渡兼容。
5. src/core/analyzers/ast.ts：类型引用为数组类型或 Promise<T[]> 时 cardinality 设为 'N:1'，单引用设为 '1:1'。
6. 测试：新增旧值迁移用例；更新受影响的现有断言并在结果说明中列出。

约束：不新增依赖；迁移是纯内存映射，读不到旧值时保持原样不报错。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿；business-agent validate 对旧知识文件仍能通过。
```

### 9.7 P1-3 规则提取扩容

**实施方法**

1. `src/core/analyzers/java.ts`：新增两类模式——字段校验注解 `@(NotNull|NotBlank|NotEmpty|Size|Min|Max|Valid)` → 候选 “Field constraint on <Entity>.<field>”；`@PreAuthorize("...")` / `@PreFilter("...")` → 权限规则候选（注解值作为 precondition）。
2. `src/core/analyzers/parse.ts`（SQL 共享解析器）：`CHECK (col IN ('A','B'))` / `CHECK (col = 'x')` → 提取列与值域为规则候选。
3. `src/core/discovery.ts` 的 RULE_PATTERNS：增加 `throw new \w*(Business|Service|Biz)\w*Exception`（自定义业务异常）。
4. `src/core/analyzers/stores.ts`：`const canXxx = computed(() => ...)` 布尔计算属性 → 规则候选（含状态读取作为 precondition）。
5. 所有新候选一律 low confidence 进候选队列，复用现有 review-state 去重（同类聚合），维持保守策略。
6. 测试：`tests/java.test.ts`、`tests/sql.test.ts`、`tests/stores.test.ts` 各补用例。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：扩大业务规则提取的覆盖面。

背景：现有规则提取只覆盖 v-if/:disabled、throw Error、状态守卫三类模式；Java 校验/权限注解、SQL CHECK 约束、自定义业务异常、前端 computed 布尔判断全部漏掉。

要求：
1. src/core/analyzers/java.ts：识别字段级校验注解 @NotNull/@NotBlank/@NotEmpty/@Size/@Min/@Max/@Valid → 规则候选（描述含实体与字段名）；识别 @PreAuthorize("...")/@PreFilter("...") → 权限规则候选，注解值作为 precondition。
2. src/core/analyzers/parse.ts：SQL CHECK 约束提取列名与值域（IN 列表或单值比较）→ 规则候选。
3. src/core/discovery.ts RULE_PATTERNS：新增 throw new \w*(Business|Service|Biz)\w*Exception 模式。
4. src/core/analyzers/stores.ts：const canXxx = computed(() => ...) 布尔计算属性 → 规则候选，computed 内读取的状态字段作为 precondition。
5. 所有新候选一律 low confidence，走现有候选聚合与 review-state 去重路径，不自动 promote。
6. 测试：tests/java.test.ts、tests/sql.test.ts、tests/stores.test.ts 各补用例（含注解、CHECK、BusinessException、computed 四类）。

约束：不新增依赖；无法解析的语法静默跳过。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿；tests/fixtures/full/java 下新增注解 fixture 能产出候选。
```

### 9.8 P1-4 规则↔测试关联

**实施方法**

1. `src/core/types.ts`：`BusinessRule` 增加 `coveringTests?: string[]`；`schemas/rule.schema.json` 同步。
2. discover 阶段（scanner 已收集 manifest.tests）：对每条规则，若某测试文件满足（文件路径含实体名或别名）且（测试内容含规则证据行 snippet、状态字面量或规则名关键词）→ 登记 coveringTests。
3. `src/core/impact.ts`：`impactMarkdown` 新增 `## Test Coverage` 节——受影响规则分两组：“有测试保护”（列出 coveringTests）/“无测试保护”（标“建议补测试”）。
4. 测试：fixture 中规则证据行出现在某 spec 文件中 → 断言 coveringTests 命中；impact 报告分组正确。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：建立规则与测试的关联（哪些规则被哪些测试保护）。

背景：impact 的测试建议靠文件名关键词匹配；没有 rule → covering tests 的证据链，改动破坏规则时无法指出“这条规则失去测试保护了”。manifest 已有 tests: string[] 清单。

要求：
1. src/core/types.ts 与 schemas/rule.schema.json：BusinessRule 增加 coveringTests?: string[]。
2. discover 阶段：对每条规则，若某测试文件（a) 路径含实体名或别名）且（b) 文件内容含规则证据行片段、状态字面量或规则名关键词）则登记 coveringTests。匹配实体名时优先用 manifest.aliases（若未落地则用实体名单复数）。
3. src/core/impact.ts impactMarkdown：新增 "## Test Coverage" 节，受影响规则分两组：有测试保护（列出 coveringTests）/ 无测试保护（标注“建议补测试”）。
4. 测试：fixture 中规则证据出现在 spec 文件 → coveringTests 命中；无关规则不被误登记；impact 报告分组正确。

约束：不新增依赖；测试文件读取失败静默跳过。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

### 9.9 P1-5 关系图 mermaid 可视化

**实施方法**

1. 抽公共 `src/core/graph.ts`：把 `impact.ts` 内的 `buildGraph`/`Graph` 移出并导出，context 与 impact 共用，避免复制。
2. `src/commands/context.ts`：对 matched 实体取 1-2 跳邻域，输出 mermaid `graph LR`（节点用显示名，边标注 `relationship/cardinality`），追加到 active-context.md 的 Relationships 节后。
3. `src/core/impact.ts`：impact 报告新增 `## Impact Graph`——受影响子图，changed module 节点高亮 `style <nodeId> fill:#f96`。
4. 测试：断言输出含 mermaid 头、高亮节点、边标签；节点数超限时截断并加说明。

**执行提示词**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：为关系图和影响分析增加 mermaid 可视化。

背景：states 已有 mermaid 输出，但关系图和 impact 报告只有文本列表，人工审阅成本高。src/core/impact.ts 内部已有 buildGraph（nodes/out/in 邻接表）可复用。

要求：
1. 把 impact.ts 的 Graph 类型与 buildGraph 抽到新文件 src/core/graph.ts 并导出，impact.ts 改为 import，行为不变。
2. src/commands/context.ts：对匹配实体取 1-2 跳邻域生成 mermaid graph LR（节点用显示名，边标签 "relationship/cardinality"），追加到 active-context.md 的 Relationships 节之后。
3. src/core/impact.ts：impactMarkdown 新增 "## Impact Graph" 节，输出受影响子图，changed module 对应节点用 style <id> fill:#f96 高亮；节点超过 40 个时截断并加一行说明。
4. 测试：断言输出含 "graph LR"、高亮 style 行、至少一条带标签的边。

约束：不新增依赖；mermaid 节点 id 做合法化处理（去特殊字符）。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

### 9.10 P2 任务提示词集

以下为 P2 各项的精简版提示词，均已执行完毕。

**P2-a OpenAPI 契约对账**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：新增 openapi 分析器，支持契约对账。
要求：
1. 新增 src/core/analyzers/openapi.ts：解析 openapi.json/yaml（yaml 可要求用户提供已转 json，零依赖原则），提取 paths → ApiRoute、schema 字段 → 实体属性，注册进 AVAILABLE_ANALYZERS（src/core/config.ts）与 analyzer 相位（实体生产相位之后）。
2. discover 时与代码侧提取的 API/实体互相校验：契约有但代码没有（或反之）→ manifest.conflicts 风格的告警；entity 字段与 schema 字段差异 → 告警。
3. src/core/impact.ts：diff 中 API 路径/响应类型变化时，对照契约输出“契约漂移”风险提示。
4. 测试：tests/openapi.test.ts，fixture 用一个最小 openapi.json。
约束：不新增依赖；解析失败告警跳过。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

**P2-b 影响深度自适应**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：让影响遍历深度自适应。
要求：
1. src/core/impact.ts：MAX_DEPTH 硬编码 3 改为配置项（config impact.maxDepth，默认 6）；traceChain 增加终止条件——到达页面/测试/API 等终止类型节点且深度≥3 时可提前剪枝，避免爆炸；MAX_CHAIN_STEPS 保留。
2. 读取 .agent/memory/impact-accuracy.json（若存在）：历史命中率为零的边类型（按 relationship 统计）降权——排序时后置，不删除。
3. 测试：深度 5-6 跳的链路能命中；无准确率数据时行为与现状一致。
约束：不新增依赖；图超过安全规模时优先保准确（截断 + warning）。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

**P2-c 知识自动保鲜（hook 增量 re-discover）**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：post-commit 后自动刷新知识新鲜度。
要求：
1. src/commands/hook.ts：post-commit 钩子在现有 capture --since last-commit 之后追加增量发现（仅扫描本次变更文件，复用 discover 的分析器逻辑，可新增 discover --files <list> 内部参数）。
2. 增量发现后：对受影响 confirmed 规则跑 validateEvidence，证据失效的自动写 knowledge-state 标记 stale（复用 knowledge stale 路径），并记录到 hook-errors.log 同级的 refresh 日志。
3. 钩子总耗时超过 10s 时只做 capture、跳过增量发现并记 warning（性能保护）。
4. 测试：修改/删除证据文件后 commit → 规则变 stale。
约束：不新增依赖；钩子任何失败不阻塞 commit（现状语义不变）。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

**P2-d 语义级规则冲突**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：冲突检测扩展到前置条件维度。
要求：
1. src/core/conflicts.ts：现有 cannot/allow 对立检测之外，新增启发式——同一实体上两条规则主语/谓语对立（不能 vs 允许/可以）但 preconditions 不同（如“审核中不能改” vs “管理员任何时候都能改”）→ 识别为“条件性冲突”，suggestions 生成“确认两者前置条件是否互斥”。
2. 前置条件归一化：中英文否定词、角色词（管理员/管理/admin）的简单词表匹配，不引入 NLP 依赖。
3. 测试：tests/conflicts.test.ts 补语义冲突用例；既有冲突用例不回归。
约束：不新增依赖；无法判定时不高声报告，只给 low confidence 建议。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

**P2-e 多仓库 linkage**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：支持前后端分仓的跨仓库链路。
要求：
1. 配置新增 linkage.externalApis?: string[]（指向其它仓库导出的 discovery-manifest.json 路径）。
2. src/core/analyzers/linkage.ts：linkFrontendModules 的 apis 入参支持合并外部 manifest 的 apis（保留 backend kind），实体名与本地实体对不上时告警不失败。
3. src/commands/config.ts 的 get/set 支持点路径 linkage.externalApis（数组写入）。
4. 测试：两个临时目录 fixture，前端仓的 axios 调用能链到外部仓后端路由与实体。
约束：不新增依赖；外部文件缺失/损坏只告警。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

**P2-f Go/Python 分析器**

```text
你是负责 business-agent 插件（TypeScript + vitest）的编码 Agent。任务：新增 Go/Python 实体分析器。
要求：
1. 照 src/core/analyzers/java.ts 的模式（正则 + 保守提取）新增 go.ts 与 python.ts：Go type struct → 实体与字段、gorm 标签 → 表名、Python dataclass/pydantic BaseModel → 实体与字段。
2. 注册进 AVAILABLE_ANALYZERS（'go'、'python'）与实体生产相位；allowedExt 补 .go/.py（保持默认关闭，仅在用户显式配置时启用）。
3. 测试：tests/go.test.ts、tests/python.test.ts 各含最小 fixture。
约束：不新增依赖；解析不了的语法静默跳过。
验收：npm run check && npm run lint && npm run format:check && npm test 全绿。
```

### 9.11 派发与验收流程建议

1. **派发顺序**：P0-3 → P0-4 → P0-1 → P0-2 →（P1 任意顺序，但 P1-1 依赖 P0-2 的别名表）→ P2 按需。
2. **每任务一个干净分支**：任务提示词派发前先 commit 当前工作区；实施 Agent 完成后人工过一遍 diff 再合并。
3. **结构变更需声明**：凡改 DiscoverManifest/Entity/Relation/BusinessRule 结构的任务，要求实施 Agent 在结果说明中列出新增字段与向后兼容策略（本节提示词已要求）。
4. **统一验收门禁**：`npm run check && npm run lint && npm run format:check && npm test && npm run build`；对改了 CLI 行为的任务（P0-3、P2-c）额外在 tests/fixtures 的样例项目里手动跑一遍命令验证输出。
5. **回归防线**：合并后跑一次 `business-agent audit`，确认既有 .agent/ 知识（若有）无 schema 破坏。

---

## 10. 下一轮优化（2026-08-31 复盘）

> P0/P1/P2 共 15 项已全部落地（G 系列 22 条差距：19 闭环 / 3 部分闭环）。
> 本节为剩余差距与发布阻塞项，按投入产出排序。全部零新增依赖。

### 第 1 批 · 发布线（阻塞项，不修发不了 npm）

| # | 任务 | 现状证据 | 落点 |
| --- | --- | --- | --- |
| R1-1 | **改包名 `business-agent-cli`** | `business-agent` 已被注册表占用（实测 v0.3.0）；`business-agent-cli` 仍可用（实测 404）；当前 package.json name 仍为 `business-agent@0.1.0`，push tag 触发 publish.yml 必失败 | `package.json`（name 改、bin 保持 `business-agent` 不变，用户零迁移） |
| R1-2 | **版本 0.2.0 + CHANGELOG** | 大量已落地功能（review 闭环、语义冲突、Go/Python、openapi、字段级传播）无版本承载；仓库无 CHANGELOG.md | `package.json`、新增 `CHANGELOG.md` |
| R1-3 | **vitest 挂住的发布风险** | Windows + Node 22.22 + vitest 4.1.10 间歇性全绿后不退出（已多次复现，`--pool=forks`/`--no-file-parallelism` 均无效）；本地可 timeout 绕过，CI（ubuntu）暂未复现，但 publish 门禁含 `npm test` | 记录为已知问题；若 CI 复现，publish.yml 的 test 步骤加超时保护 |

### 第 2 批 · 关系精度收尾

| # | 任务 | 解决 | 现状证据与实施方法 | 落点 |
| --- | --- | --- | --- | --- |
| R2-1 | **共现关系同文件约束 + 记录证据** | G2.3 治本 | `detectRelations` 目前在全仓库拼接文本上做 150 字符窗口共现 + 宽松 structural hint，且产出关系 `evidence: []`（无任何证据）。改为：按 SampleFile 逐文件检测，共现与 structural hint 必须命中**同一文件**，该文件记入 evidence；置信度保持 low。影响图噪声源头直接少一个量级 | `src/core/discovery.ts`（detectRelations 签名改收 samples） |
| R2-2 | **历史准确率参与排序** | G4.6 收尾 | `loadLowAccuracyRelationships` 只过滤零命中边类型；impact 输出无任何排序。补：链路/风险条目按 `(confidence, relationshipAccuracy.precision)` 降序排列，预测准的关系排前——补齐第 8 节验收标准最后一公里 | `src/core/impact.ts` |

### 第 3 批 · 规则说业务话（无 LLM 也生效）

| # | 任务 | 解决 | 现状证据与实施方法 | 落点 |
| --- | --- | --- | --- | --- |
| R3-1 | **条件文本直接进规则** | G3.2 | `ruleDescription` 已是中文模板但仍泛化（"在特定业务条件下限制用户操作"）；detectRules 只记 evidence 文件、丢弃匹配到的条件原文。改为：按模式提取匹配片段（如 `status === 'AUDIT'`），rule 文本具体化为"当 status 为 AUDIT 时禁止编辑核心字段"级别的描述；thrown-error 已拼异常消息，其余模式对齐 | `src/core/discovery.ts`（detectRules / RULE_PATTERNS） |
| R3-2 | **角色/条件词归一进 preconditions** | G3.5 输入质量 | conflicts.ts 已有角色词表雏形（admin/管理员），复用到规则提取侧：条件文本含角色词时写入 `preconditions`，让语义冲突检测拿到结构化输入 | `src/core/discovery.ts`、`src/core/conflicts.ts` |

### 第 4 批 · 可选深水区（不建议现在做）

- SQL 递归下降解析（多 JOIN/CTE，原 ROADMAP 4.1）：仅当项目大量使用复杂 SQL 才值得，现有保守提取够用；
- 实体画像描述（属性/规则/API 计数拼装进 description）：锦上添花；
- 向量检索 / 运行时证据采集：维持"不建议"结论不变。

### 实施顺序

```text
R1-1 → R1-2 → R2-1 → R2-2 → R3-1 → R3-2
（第 1 批纯配置与文档；R2-1 改 detectRelations 签名后需同步 discovery 调用处与相关测试断言）
```
