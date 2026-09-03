# business-agent 插件优化建议

> 审核日期：2026-09-03
> 观察版本：`business-agent 0.2.0`
> 范围：`cip-views/.agent` 积累库审核、晋级、检索和校验流程

## 结论

插件需要优化。当前流程可以沉淀知识，但候选状态、晋级标识、索引和审计使用了不同的数据来源，容易出现“已审核但仍被当作待审核”“已晋级候选压过正式规则”等结果。它更适合作为 P0/P1 级别的可靠性改进，而不是新增功能。

审核台账的 `audit.summary` 记录了 91 条候选处理结果：9 条晋级、5 条已被正式规则覆盖、11 条保留待核验、66 条拒绝；插件可读取的 `review-state.decisions` 实际只有 57 条。当前候选目录仍有 92 个 Markdown 文件，文件状态、审核台账和发现清单并未完全同步；这正是下文重点问题之一。

## 优先级问题

| 优先级 | 已验证现象 | 风险 | 建议 |
| --- | --- | --- | --- |
| P0 | 中文候选标题直接执行 `promote` 会生成通用 ID `rule.promoted-rule`，多个候选会发生覆盖。 | 正式规则丢失或被错误覆盖，且难以从结果反查来源。 | 以候选文件的稳定 ID 生成规则 ID；冲突时失败退出并要求显式 `--id`，禁止覆盖已有规则。 |
| P0 | 候选状态靠 Markdown 中的字面文本判断。`review` 只识别 `Status: promoted` 与 `Status: rejected`；`- 状态: candidate` 和缺少 Status 的候选不会被统一识别。 | 同一批候选会被不同命令以不同方式统计，重复评审或遗漏评审。 | 用 YAML front matter 或 JSON 元数据定义状态枚举，并在所有命令中复用同一个解析器。 |
| P0 | 原始检索索引会同时收录已晋级、已拒绝候选与正式规则；本次“批改申请报批号”检索中，已晋级候选曾排在正式规则之前。 | 后续 Agent 可能优先读取假设、过期描述或已拒绝噪声。 | 索引默认只收录正式规则和 `needs-verification` 候选；`promoted`、`rejected` 只保留审计记录，不参与默认检索。 |
| P1 | `audit` 的 `noise` 只读取 discovery manifest 的 `rules[].status`。当前它报告“无待评审候选”，但候选目录仍有 92 个 Markdown，其中 25 个仍标记为 `candidate`、1 个缺少状态；审核汇总为 91 条，而插件实际可读取的 `review-state.decisions` 只有 57 条。 | 审计结果不能反映真实待办，使用者无法区分已决、待核验和状态漂移。 | 审计输出应分别统计“发现清单候选”“候选文件”“审核已决”“待补证据”，并对差异给出可执行的 reconcile 操作。 |
| P1 | `review-state.decisions` 依赖 discovery manifest 的 `{entity,name}` 键；候选 Markdown 又以自由文本存状态，两者无法稳定关联手工新增或改名后的候选。 | 审核结果没有单一可信来源，重建或迁移后可能丢失或被错误复用。 | 每个候选必须有稳定 `candidateId`，review-state 以该 ID 为键；支持 `approved`、`covered`、`rejected`、`needs-verification` 及原因、审核时间、目标规则 ID。 |
| P1 | `rebuild-index` 只更新检索索引，不更新 `business/INDEX.md`；正式规则、影响图和索引入口需要人工三处同步。 | 文件存在但不可发现，或 INDEX 链接漂移。 | 提供一个原子 `index rebuild`：同步生成检索索引、正式规则目录和影响图目录，并在校验中检查链接完整性。 |
| P1 | `validate` 已通过，但本次仍需额外脚本检查正式规则 JSON 可解析、ID 无重复、证据非空、候选分类闭合。 | 正式规则、Markdown、影响图和索引之间的不一致可能漏检。 | 将这些检查纳入插件：规则 JSON/Markdown/impact 三件套、唯一 ID、证据路径、INDEX 链接、状态闭合和检索去重。 |
| P2 | CLI 当前未作为项目本地依赖暴露，需要借助外部安装位置调用。 | 团队成员、CI 和不同机器的版本容易漂移。 | 以项目本地 dev dependency 或封装脚本提供 `pnpm business-agent`，锁定插件版本并在 CI 中运行。 |

## 推荐状态模型

候选应使用统一元数据，而不是从自然语言段落推断状态。例如：

```yaml
---
candidateId: candidate.correct-apply-no-approval-display
status: approved # needs-verification | covered | rejected | approved
confidence: high
reviewedAt: 2026-09-03
targetRuleId: rule.correct-apply-no-approval-display
reason: 前端实现、请求 DTO 和接口资料相互印证
---
```

规则晋级、合并和拒绝应对应明确命令：

```text
business-agent promote <candidateId> --id rule.xxx
business-agent promote <candidateId> --into rule.existing
business-agent review <candidateId> --reject --reason "..."
business-agent review <candidateId> --covered-by rule.existing
```

`needs-verification` 仍应出现在默认检索的低置信度分区；`approved`、`covered`、`rejected` 不应作为候选参与默认检索。

## 建议落地顺序

### 第一阶段：消除错误晋级和重复检索

1. 修复规则 ID 生成和冲突检测，禁止 `rule.promoted-rule` 覆盖。
2. 引入统一状态解析器，并让 `review`、`audit`、`retrieve`、`index` 共用它。
3. 让检索索引排除 `promoted` 和 `rejected` 候选。
4. 支持 `--into` 与 `--covered-by`，覆盖“候选合并入既有规则”的常见审核结论。

### 第二阶段：让审计结果可追溯

1. 为候选增加稳定 ID，替换基于标题或 manifest 结构的状态键。
2. 将审核原因、证据、审核人和目标规则 ID 写入正式 review-state schema。
3. `audit` 同时校验 manifest、候选文件和 review-state，并明确报告三者差异。
4. 将正式规则 JSON、Markdown、impact map 和 `INDEX.md` 的一致性纳入 `validate`。

### 第三阶段：提升团队可用性

1. 将 CLI 接入项目本地包管理和 CI。
2. 对证据记录增加可选的文件行号、内容哈希或提交版本，便于检测证据漂移。
3. 为批量审核提供 JSON 报告和可重复执行的非交互命令，避免人工编辑几十个候选状态。

## 验收标准

优化完成后，应至少满足以下条件：

1. 两个中文标题候选连续晋级时，插件生成不同且可预测的规则 ID；碰撞不会覆盖文件。
2. 候选文件、review-state 和 `audit --json` 对同一批候选给出一致的已决/待核验计数。
3. 已晋级和已拒绝候选不出现在默认 `retrieve` 结果中，正式规则优先返回。
4. `validate --json` 对每条正式规则报告 JSON、Markdown、impact、INDEX 和证据检查结果，并在任何一项缺失时失败。
5. `index rebuild` 后不需要人工维护规则索引和影响图索引。

## 本项目已做的临时补偿

本次已在 `cip-views/.agent/bin/rebuild-index.mjs` 中补充状态过滤：已晋级和已拒绝候选不再进入本地检索索引。该调整仅解决当前项目的检索污染问题，建议将同等能力实现到插件核心，而不是长期依赖项目级补丁。
