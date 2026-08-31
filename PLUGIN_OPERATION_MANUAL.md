# business-agent 插件操作手册

> 对应版本：`business-agent-cli` v0.2.0（bin 命令仍为 `business-agent`）。
> 0.2.0 相比 0.1.0 的主要变化见仓库 `CHANGELOG.md`：字段级影响传播、规则违反判定（Rule Violations）、
> 规则↔测试覆盖（Test Coverage）、mermaid 关系/影响图、中文术语表（glossary）接线、
> OpenAPI 契约对账、Go/Python 分析器、跨仓库 linkage、`impact.maxDepth` 可配置。

## 1. 给助手的常用提示词

如果你以后想让我在别的项目里直接帮你安装、初始化、扫描这个插件，可以直接复制下面这些提示词。

### 1.1 纯本地静态扫描版

适合你不想调用其它模型、只想让我帮你完成安装和扫描的场景。

```text
帮我在当前项目安装并初始化 business-agent。
要求：
1. 只使用本地静态扫描，不启用 llm 和 llm-rules
2. 配置为适合 Vue 项目的 analyzers
3. 执行 business-agent init
4. 执行 business-agent discover --deep
5. 读取扫描结果并帮我总结页面、store、API、候选规则和主要风险
```

### 1.2 本地静态扫描 + 人工分析版

适合你希望我不仅跑扫描，还顺手帮你筛选哪些候选值得关注的场景。

```text
帮我在当前项目初始化 business-agent，并只使用本地静态扫描。
然后帮我执行 discover --deep，读取 .agent/memory/discovery-manifest.json，重点分析：
1. 主要业务页面
2. 关键 store / composable
3. API 调用链
4. 候选业务规则
5. 哪些规则值得 review 或 promote
不要启用任何 LLM 扫描。
```

### 1.3 启用 LLM 增强扫描版

适合你以后想让我帮你接入 OpenAI-compatible 或本地模型增强扫描的场景。

```text
帮我在当前项目初始化 business-agent，并启用 LLM 增强扫描。
要求：
1. 保留 Vue 项目推荐 analyzers
2. 启用 llm-rules
3. 按我提供的模型配置写入 .agent/business-agent.json
4. 执行 business-agent init --force
5. 执行 business-agent discover --deep
6. 帮我总结扫描结果，并指出哪些结论只是候选，不是确认规则
```

### 1.4 最省事的一句话版本

```text
帮我在当前项目安装并初始化 business-agent，按 Vue 项目最佳实践配置，先做一次深度扫描，再帮我解读结果。
```

### 1.5 真实项目接入时的标准安装命令模板

如果你准备用固定安装产物，而不是 `npm link`，推荐直接用下面这组命令。

#### 方式 A：安装本地 `.tgz` 稳定包

```bash
cd your-vue-project
npm install "d:\\work\\business-agent-plugin-skeleton\\business-agent-cli-0.2.0.tgz"
npx business-agent init
npx business-agent discover --deep
```

#### 方式 B：升级到新的稳定包

```bash
cd your-vue-project
npm install "d:\\work\\business-agent-plugin-skeleton\\business-agent-cli-0.2.0.tgz"
npx business-agent discover --deep
```

升级插件程序不会自动覆盖项目中的业务知识库。项目知识库保存在项目目录的 `.agent/` 下，重新安装新的 `.tgz` 只会更新 `business-agent` 程序代码，通常会保留以下内容：

- `.agent/business/`：已确认的实体、规则、关系和工作流
- `.agent/memory/candidates/`：候选知识
- `.agent/memory/task-history/`：任务历史
- `.agent/memory/feedback/`：反馈记录
- `.agent/memory/discovery-manifest.json`：扫描结果
- `.agent/business-agent.json`：项目配置

升级前建议备份知识库：

```bash
cp -R .agent .agent.backup
```

Windows PowerShell：

```powershell
Copy-Item .agent .agent.backup -Recurse
```

升级后建议检查并重建索引：

```bash
npx business-agent audit
npx business-agent validate
npx business-agent index rebuild
```

`index rebuild` 只会根据现有知识重建检索索引，不会清空知识库。已有 `.agent/` 时，不要直接执行 `business-agent init --force`；该选项会重新应用模板文件，只有在确认需要更新模板时才使用。

#### 方式 C：只做本地静态扫描

```bash
cd your-vue-project
npx business-agent config set analyzers "[\"sql\",\"api\",\"ast\",\"vue\",\"stores\",\"frontend\",\"linkage\",\"states\"]"
npx business-agent config set autoPromote never
npx business-agent config set llm.allowSourceUpload false
npx business-agent discover --deep
```

#### 方式 D：接入后让我继续帮你分析

```text
我已经在项目里安装好了 business-agent 的 tgz 稳定包。
请继续帮我：
1. 初始化配置
2. 执行深度扫描
3. 读取 discovery manifest
4. 总结页面、store、API、候选规则和风险
5. 如果有价值，再告诉我哪些候选值得 review
```

---

## 2. 插件简介

`business-agent` 是一个面向代码仓库的业务知识提取与沉淀 CLI。

它的核心目标不是直接替代你读代码，而是把项目中的业务实体、规则、关系、前端页面、用户动作、状态机、工作流和任务经验整理到 `.agent/` 目录里，方便你后续检索、复用，并在与大模型协作时减少重复贴源码。

对个人 Vue 项目来说，它更适合定位为：

- 业务知识候选发现工具
- 改动影响分析工具
- 本地业务记忆层
- 大模型上下文压缩工具

---

## 3. 适合谁用

推荐使用场景：

- 你个人长期维护一个 Vue 项目
- 项目页面、store、composable、接口链路较多
- 你经常需要回忆“这个页面为什么这么限制”
- 你希望把已确认的业务规则沉淀下来
- 你希望减少和大模型对话时反复贴源码

不太推荐的场景：

- 项目非常小，直接全局搜索已经足够快
- 你不打算维护任何业务知识沉淀
- 你希望它一次扫描后就直接给出完全正确的业务结论

---

## 4. 安装与准备

### 4.1 在插件仓库中构建

```bash
npm install
npm run build
```

### 4.2 推荐的稳定接入方式：使用 `.tgz` 安装产物

如果你希望运行中的项目不受当前源码仓库持续开发影响，推荐使用固定安装产物，而不是 `npm link`。

在插件仓库根目录生成稳定包：

```bash
npm pack
```

执行后会生成类似下面的文件：

```text
business-agent-cli-0.2.0.tgz
```

然后在真实项目中安装这个固定包：

```bash
cd your-vue-project
npm install "d:\\work\\business-agent-plugin-skeleton\\business-agent-cli-0.2.0.tgz"
```

安装后建议通过 `npx` 调用，确保使用的是当前项目里已安装的固定版本：

```bash
npx business-agent init
npx business-agent discover --deep
```

这样即使你继续修改这个插件仓库的源码，也不会自动影响真实项目。只有当你重新打包并在真实项目里重新安装新的 `.tgz` 时，真实项目才会升级。

### 4.3 不推荐长期使用 `npm link`

`npm link` 更适合本地联调，不适合作为长期运行方式，因为你后续继续修改源码、重新 build 或重新 link 后，真实项目的行为会跟着变化。

### 4.4 在你的 Vue 项目中初始化

进入你的项目目录：

```bash
cd your-vue-project
npx business-agent init
```

执行后会生成 `.agent/` 目录，用于保存业务知识、候选规则、索引、上下文和任务记录。

---

## 5. 目录结构说明

初始化后，常用目录如下：

```text
.agent/
├─ business/
│  ├─ entities/        # 已确认的业务实体
│  ├─ rules/           # 已确认的业务规则
│  ├─ relationships/   # 已确认的关系
│  ├─ states/          # 状态机输出
│  ├─ workflows/       # 工作流文档
│  ├─ glossary.md      # 业务术语表（中文词 → 实体别名，强烈建议维护）
│  └─ INDEX.md         # 业务索引
└─ memory/
   ├─ candidates/      # discover 产生的候选规则
   ├─ discovery-manifest.json
   ├─ active-context.md
   ├─ review-state.json
   ├─ impact-accuracy.json   # 影响预测准确率统计（task 积累）
   ├─ hook-refresh.log       # post-commit 增量刷新日志
   ├─ sessions/        # task 生命周期记录
   ├─ indexes/         # retrieval 索引
   └─ task-history/    # 任务历史
```

可以简单理解为：

- `business/` 存放“确认过的知识”
- `memory/` 存放“扫描结果、候选、上下文、历史和索引”

---

## 6. 个人 Vue 项目推荐配置

从 0.2.0 起，`discover`（不带 `--deep`）默认就运行 `sql / api / ast` 三个零依赖分析器，
`--deep` 在此之上追加 `vue / stores / frontend / java / xml / linkage / states`。
配置里显式写 `"analyzers": [...]` 会整体替换默认值（写 `[]` 可全部关闭）。

建议在 `.agent/business-agent.json` 中先使用偏保守配置。

推荐配置：

```json
{
  "analyzers": ["sql", "api", "ast", "vue", "stores", "frontend", "linkage", "states"],
  "autoPromote": "never",
  "maxSampleFiles": 80,
  "maxSamplesPerExt": 40,
  "impact": { "maxDepth": 6 },
  "llm": {
    "provider": "openai-compatible",
    "apiKeyEnv": "OPENAI_API_KEY",
    "allowSourceUpload": false
  }
}
```

说明：

- `vue`：分析 Vue SFC、props、emits、模板条件
- `ast`：分析 TypeScript 类型与引用
- `stores`：分析 store/composable 中的业务逻辑
- `frontend`：分析页面、动作、权限、校验、状态读写
- `linkage`：把前端调用链和 API 关联起来；前后端分仓时可配 `linkage.externalApis` 指向另一仓库导出的 `discovery-manifest.json`
- `states`：状态机提取，`entity.states` 生命周期回链依赖它
- `impact.maxDepth`：影响遍历深度上限（默认 6，范围 1-10）
- `autoPromote: never`：禁止自动提升候选，避免误把 UI 逻辑当业务事实
- `allowSourceUpload: false`：默认关闭源码上传，更适合个人本地使用

### 6.1 查看配置

```bash
business-agent config get
```

### 6.2 设置配置

```bash
business-agent config set autoPromote never
business-agent config set maxSampleFiles 80
business-agent config set impact.maxDepth 6
business-agent config set llm.allowSourceUpload false
```

---

## 7. 第一次接入推荐流程

对于个人 Vue 项目，建议用下面的节奏接入。

### 第一步：初始化

```bash
business-agent init
```

### 第二步：先做一次深度扫描

```bash
business-agent discover --deep
```

如果只想先看结果，不写文件：

```bash
business-agent discover --deep --json --dry-run
```

### 第三步：评审候选规则

```bash
business-agent review
```

你会逐条看到候选规则、上下文和确认选项。

### 第四步：生成业务上下文

```bash
business-agent context Order
```

如果你关注的是某个业务模块，也可以传模块名称，例如：

```bash
business-agent context 审核
business-agent context OrderEdit
business-agent context 订单
```

### 第五步：开始在真实改动任务中使用

在你准备修改功能前、修改中、修改后逐步引入 `impact`、`task`、`retrieve`、`audit`。

### 第六步（强烈建议）：维护业务术语表

中文业务词要能命中实体，靠的是 `.agent/business/glossary.md`。首次 `init` 后编辑它：

```markdown
| 术语 | 别名             | 实体  |
| ---- | ---------------- | ----- |
| 订单 | OrderDTO, orders | Order |
| 缴费 | PremiumPayment   | Order |
```

规则：

- 三列固定为 `术语 | 别名 | 实体`，一行一条
- `术语`是你平时说的中文词；`别名`是代码里出现过的其它叫法；`实体`必须是已发现的实体名
- 改完后重跑 `business-agent discover`（不需要 --deep），术语会自动注入实体别名、tags 和描述
- 之后 `business-agent context 缴费` 就能直接命中 Order 实体及其全部关系

---

## 8. 常用命令手册

## 8.1 `init`

作用：初始化 `.agent/` 目录结构。

```bash
business-agent init
```

强制重新应用模板：

```bash
business-agent init --force
```

适用场景：

- 第一次接入项目
- 需要重建模板目录

---

## 8.2 `discover`

作用：扫描项目并生成初始业务知识候选。

```bash
business-agent discover
```

不带 `--deep` 时默认运行 `sql / api / ast` 三个分析器（0.2.0 起），已有基础产出。

深度扫描（追加 vue / stores / frontend / java / xml / linkage / states）：

```bash
business-agent discover --deep
```

只输出 JSON，不写文件：

```bash
business-agent discover --deep --json --dry-run
```

执行后通常会得到：

- 实体 `entities`
- 关系 `relations`
- 候选规则 `rules`
- 前端页面 `pages`
- 用户动作 `actions`
- 工作流 `workflows`
- 冲突 `conflicts`

对 Vue 项目最有价值的是：

- 页面和组件关联
- store/composable/API 使用链
- `v-if` / `:disabled` / 权限 / 表单校验提取出的候选规则

注意：

- `discover` 生成的大部分规则是候选，不代表已经确认
- 候选规则通常存放在 `.agent/memory/candidates/`
- 已确认规则才会进入 `.agent/business/rules/`

---

## 8.3 `review`

作用：评审 discover 产生的候选规则。

交互式评审：

```bash
business-agent review
```

非交互式评审：

```bash
business-agent review --non-interactive --accept medium --reject low
```

机器可读输出：

```bash
business-agent review --json
```

建议个人 Vue 项目使用方式：

- 交互式查看候选
- 只确认你非常确定的规则
- 对明显属于展示逻辑的候选直接 reject 或跳过

评审状态会记录在：

```text
.agent/memory/review-state.json
```

这样同类候选不会在后续反复复活。

---

## 8.4 `promote`

作用：把已验证的候选提升为确认知识。

```bash
business-agent promote <candidate>
```

示例：

```bash
business-agent promote 审核中的订单不能修改 --entity Order
```

使用建议：

- 只有在你自己确认它是真实业务规则时才 promote
- 对个人 Vue 项目，建议把“按钮灰掉”类规则再往业务层判断一次

---

## 8.5 `context`

作用：围绕某个主题生成当前业务上下文。

```bash
business-agent context Order
```

JSON 输出：

```bash
business-agent context Order --json
```

生成内容通常包括：

- 相关实体（含别名与状态生命周期 `entity.states`）
- 相关规则
- 相关关系 + **mermaid 关系图**（1-2 跳邻域）
- 冲突
- 状态机（mermaid 状态图）
- 前端页面
- 工作流
- 用户动作
- 相关 API
- 相关 impact map

输出文件：

```text
.agent/memory/active-context.md
```

这是最适合拿去喂给大模型的内容之一。

---

## 8.6 `impact`

作用：分析改动文件可能影响到哪些业务知识。

```bash
business-agent impact
```

也可以手动指定文件：

```bash
business-agent impact src/views/OrderEdit.vue src/stores/orderStore.ts
```

JSON 输出：

```bash
business-agent impact src/views/OrderEdit.vue --json
```

0.2.0 的报告新增四块内容：

- **Rule Violations**：本次改动删除/修改了某条已确认规则的证据代码时，直接点名"违反 rule X"（最高优先级，同时出现在 Risks 首位）
- **Test Coverage**：受影响规则分"有测试保护 / 无测试保护"两组，后者就是你该补测试的地方
- **Impact Graph**：受影响子图的 mermaid 图，改动模块高亮
- **字段级传播**：改一个 SQL 字段能给出"表 → API → Store → 页面 → 测试"全链路；深度由 `impact.maxDepth` 控制（默认 6）

关系条目按置信度与历史预测准确率排序（`impact-accuracy.json` 积累越久排序越准）。

推荐在以下场景使用：

- 修改页面前，先看影响范围
- 改完关键 store 或 API 封装后，确认影响链
- 准备向大模型提问前，先收窄上下文

---

## 8.7 `task`

作用：记录一次任务的完整生命周期。

### 开始任务

```bash
business-agent task start "修改订单审核流程"
```

### 获取任务上下文

```bash
business-agent task context
```

### 预测影响

```bash
business-agent task predict-impact --files src/stores/orderStore.ts,src/views/OrderEdit.vue
```

### 改动后做 checkpoint

```bash
business-agent task checkpoint
```

### 记录测试情况

```bash
business-agent task test --command "npm test" --passed true --summary "All tests passed"
```

### 完成任务并沉淀经验

```bash
business-agent task finish "完成订单审核流程" --learn "审核中的订单不能修改"
```

适合个人使用的价值：

- 把你做过的改动和经验记下来
- 以后再次问同类问题时可直接检索
- 帮助你减少对历史任务的重复解释

---

## 8.8 `retrieve`

作用：从历史知识、候选、任务经验中检索相关上下文。

```bash
business-agent retrieve "订单审核"
```

示例：

```bash
business-agent retrieve "审核状态 按钮禁用"
business-agent retrieve "OrderEdit 审核 提交"
```

作用理解：

- `context` 更偏“围绕一个主题做聚合”
- `retrieve` 更偏“围绕一个查询词做检索”

如果你想节省 token，`retrieve` 非常重要，因为它能把全仓信息压缩成少量高相关结果。

---

## 8.9 `index rebuild`

作用：重建检索索引。

```bash
business-agent index rebuild
```

适用场景：

- 你手动改过 `.agent/` 下的知识文件
- 新增了较多任务历史或反馈
- 检索结果和预期不一致时

---

## 8.10 `knowledge`

作用：查看或更新某条知识的状态。

查看状态：

```bash
business-agent knowledge status rule-order-review
```

标记已验证：

```bash
business-agent knowledge verify rule-order-review --reason "人工复核并通过测试验证"
```

标记为 stale：

```bash
business-agent knowledge stale --id rule-order-review --reason "证据文件已删除"
```

适合个人使用时：

- 某条旧规则已经不适用
- 某条知识已被你再次验证
- 项目重构导致旧证据失效

---

## 8.11 `audit`

作用：对当前知识库做健康检查。

```bash
business-agent audit
```

JSON 输出：

```bash
business-agent audit --json
```

它会检查：

- `.agent/` 是否完整
- manifest 是否有效
- schema 是否通过
- 候选是否堆积过多
- 知识是否 stale / contradicted / deprecated
- 证据文件是否漂移或丢失
- hook 和 task session 是否异常

建议个人使用频率：

- 每完成一个较大功能后跑一次
- 每隔一段时间做一次清理

---

## 8.12 `validate`

作用：验证 discovery manifest 和确认知识是否符合 schema。

```bash
business-agent validate
```

建议在以下情况下执行：

- 大量 promote 后
- 手动修改过知识文件后
- 准备长期保留知识库时

---

## 8.13 `states`

作用：提取状态机并输出 Mermaid 图。

```bash
business-agent states
```

JSON 输出：

```bash
business-agent states --json
```

适合场景：

- 订单状态流转
- 审核流程状态流转
- 页面内部状态约束较多的模块

注意：

- 状态机提取已并入 `discover --deep`（0.2.0 起），结果回写到实体的 `states` 字段
- 当前状态机更偏启发式提取
- 结果适合作为辅助理解，不建议直接当作绝对事实

---

## 8.14 `workflow`

作用：生成手工维护的工作流模板。

```bash
business-agent workflow order-review
```

这会在 `.agent/business/workflows/` 下创建一个工作流 Markdown 文件。

适合场景：

- 你希望手工整理“一个业务流程怎么走”
- 自动扫描结果不足以完整描述流程时

---

## 8.15 `learn`

作用：记录一条新的业务发现，作为候选等待评审。

```bash
business-agent learn "审核中的订单不能修改"
```

适用场景：

- 你在改代码时确认了一条业务事实
- 它还没有被 discover 自动发现

---

## 8.16 `conflicts`

作用：查看规则冲突和建议。

```bash
business-agent conflicts
```

JSON 输出：

```bash
business-agent conflicts --json
```

适用场景：

- 发现同一业务实体存在相互冲突的限制
- 你想回头清理历史规则

---

## 8.17 `deprecate`

作用：废弃一条已确认规则。

```bash
business-agent deprecate <rule-id>
```

适用场景：

- 旧业务规则已失效
- 流程重构后规则被替换

---

## 9. 个人 Vue 项目的推荐使用流程

下面是一套最实用的轻量流程。

### 场景 A：第一次接入项目

```bash
business-agent init
business-agent config get
business-agent discover --deep
business-agent review
business-agent context Order
```

### 场景 B：准备修改一个页面

```bash
business-agent context OrderEdit
business-agent impact src/views/OrderEdit.vue src/stores/orderStore.ts
```

### 场景 C：修改完成后沉淀经验

```bash
business-agent task start "修改订单审核按钮禁用逻辑"
business-agent task context
business-agent task checkpoint
business-agent task test --command "npm test" --passed true --summary "order module ok"
business-agent task finish "完成按钮逻辑修复" --learn "审核中的订单不能修改"
```

### 场景 D：下次再问大模型前

```bash
business-agent retrieve "订单审核 按钮禁用"
business-agent context Order
```

然后把检索结果或 `active-context.md` 提供给大模型，而不是整个源码目录。

---

## 10. 如何用它节省 token

这是个人使用时最值得关注的点之一。

### 推荐方法

不要每次都把这些内容直接发给大模型：

- 整个 Vue 页面
- store 文件
- composable 文件
- API 调用封装
- 历史需求解释

改成：

1. 先运行 `business-agent context <subject>`
2. 或运行 `business-agent retrieve <query>`
3. 再把生成的上下文结果发给大模型

### 最适合节省 token 的场景

- 反复提问同一个业务模块
- 项目接手一段时间后重新回忆上下文
- 多次修改同一业务流程
- 你已经沉淀了较多已确认规则和任务历史

### 需要注意

- 第一次建库通常不会节省 token，反而是前期投入
- 真正节省发生在后续重复使用阶段
- 如果候选知识质量差，虽然 token 变少，但结论可能更偏

---

## 11. 个人使用时的最佳实践

- 把它当“辅助理解工具”，不要当“绝对事实系统”
- 先从一个核心业务模块开始，不要一上来扫全仓
- 永远先 review，再 promote
- 对 Vue 页面中提取出的规则，多做一次业务判断
- 默认关闭源码上传
- 定期跑 `audit` 和 `validate`
- 真正高价值的业务规则才沉淀，避免知识库膨胀

---

## 12. 常见问题

### 12.1 为什么 discover 后候选很多？

因为前端 Vue 页面里 `v-if`、`:disabled`、权限和校验都可能被识别为候选规则。

处理建议：

- 不要追求一次性全确认
- 先处理最核心模块
- 只 promote 确认过的规则

### 12.2 为什么它提取的规则看起来像 UI 逻辑？

这是正常现象。前端代码里很多业务规则就是通过 UI 限制表现出来，但并不等于它们都是真正的业务事实。

所以你需要自己判断：

- 这是展示限制
- 还是业务限制

### 12.3 为什么检索结果不理想？

可能原因：

- 还没有积累足够知识
- 没有完成 review/promote
- 任务历史较少
- 索引需要重建

可以尝试：

```bash
business-agent index rebuild
business-agent audit
```

### 12.4 我需要开 LLM 吗？

个人 Vue 项目建议先不开。

优先用本地静态分析，等你确认基本流程有价值后，再考虑是否需要额外 LLM 增强。

### 12.5 为什么用中文词检索/context 命中不了实体？

中文命中依赖业务术语表。检查 `.agent/business/glossary.md`：

- 表头必须是 `| 术语 | 别名 | 实体 |` 三列
- 每个你要用中文说的业务对象加一行，实体列填扫描出的实体名
- 改完重跑 `business-agent discover`（术语在 discover 阶段注入实体与索引）

### 12.6 impact 报告说"违反 rule X"是什么意思？

你的改动删除或修改了某条已确认规则的证据代码行（比如删掉了 `if (status === 'AUDIT') throw ...`）。
这是最高优先级风险：要么规则真的被破坏了，要么需要重新 review 这条规则。去 `business-agent audit` 复核。

---

## 13. 一套最小可用命令清单

如果你只想先用最核心能力，可以只记住下面这些：

```bash
business-agent init
business-agent discover --deep
business-agent review
business-agent context 订单
business-agent impact src/views/OrderEdit.vue
business-agent retrieve "订单审核"
business-agent audit
```

中文命中的前提是维护好 `.agent/business/glossary.md`（见第 7 节第六步）。

---

## 14. 结论

对个人 Vue 项目来说，`business-agent` 最值得用的不是“自动懂业务”，而是：

- 帮你把项目里分散的业务线索聚起来
- 帮你在改动前后快速收窄上下文
- 帮你沉淀自己的业务记忆
- 帮你在与大模型协作时减少重复贴源码

如果你能坚持用 `discover + review + context/retrieve + impact` 这条主链路，它会越来越有价值。
