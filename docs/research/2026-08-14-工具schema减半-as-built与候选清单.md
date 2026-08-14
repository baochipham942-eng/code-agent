# 工具 schema 减半：as-built 与候选清单

日期：2026-08-14（N-L8-ATT6 调研 / ATT8 门 / SLIM2 落地）

## ⚠️ 口径修正（2026-08-14 SLIM2 施工时发现，先读这段）

本报告初稿沿用 ATT1 的 **「JSON 序列化字符数 ÷ 3」** 估算口径。SLIM2 施工时改用 Neo 自己的 tokenizer（`tokenEstimator` 的 `encode`）实测，发现该口径**按语言系统性偏斜**：

| 内容 | 真 token / (字符÷3) |
| --- | ---: |
| 纯中文 | **2.16**（÷3 把中文低估一半以上） |
| 纯英文 | **0.44**（÷3 把英文高估一倍多） |

后果有二：

1. **绝对值偏高**。工具 schema 几乎全英文，所以整桶被高估约三成。真 tokenizer 口径下：CORE 23 个 = **7877 token**（不是 10371）。
2. **桶间比例失真**，这条更要紧。ATT1 报「工具 schema 占每轮 45~51%」——那一桶全英文被高估，而静态系统提示里大量中文规则被低估，**真实占比应低于报告值**。ATT1 五桶分解需要按真 tokenizer 重算，另起一单。

下文凡标注「÷3」的是初稿口径（保留以便对账），标注「真」的是 tokenizer 实测值。**结论性判断以真值为准**；好在两个口径下"脂肪在参数里"「TaskManager 是最大单点」这两条判断都不变。

## 结论

工具 schema 桶当前 **7877 token（真）/ 23 个工具**（÷3 口径为 10371；已含 #1130 去重七连与 #1131 `_meta` 退役的收益）。

三条可下手的事实：

1. **约七成体积在 `inputSchema`，不在 description。** 挪出七个后剩余 16 个的真值构成：描述 1375（29.8%）、参数 3104（67.4%）。#1130 砍的是描述，剩下的脂肪在每个参数的 property description 里。**该结论在两个口径下一致。**
2. **`TaskManager` 一个占 1995 token（真，占整桶 25.3%），两个独立信源都显示它零使用。** 工具执行账本 06-17~08-14 共 4563 次执行、dev 槽 08-08~08-14 共 185 次执行，`TaskManager` 一次没有；`session_tasks` 表 79 行任务的最后一行停在 2026-06-11。
3. **ToolSearch 的召回是纯词法匹配，且有 19 个已注册工具真·不可达**（另 15 个由门面代理、1 个走 strict skill 注入，属设计内）。 但 `select:<工具名>` 这条路是稳的——名字来自每轮随静态提示下发的名字索引（真 1772 token），不依赖搜索质量。

因此**敢砍，但只敢砍一种**：把 CORE 工具挪进 deferred（模型仍能在名字索引里看见、`select:` 加载）。**不敢动的是名字索引本身**——那 1772 token（真）是可发现性的地基，砍它才是本单最大的翻车风险。

候选合计 **净省 3109 token/轮（真），占当前工具 schema 桶的 41.5%**，全部只需改 `CORE_TOOLS` 数组和补 meta，不动任何工具实现。

## as-built

### CORE_TOOLS：23 个，无入选依据

工单写的 24 是错的——`deferredTools.ts` 里 `'TodoWrite'` 那行是注释掉的，实际 23 个，与 ATT1 实测"普通/多 agent 每轮 23 个函数工具"对上。

**没有任何成文依据。** 源码里只有 `Gen 1: 基础文件操作` / `Gen 2: 代码搜索` / `Gen 3: 规划和任务` / `Gen 4: 网络搜索` 四个分代注释，是复刻 Claude Code 八代架构时的历史分组，与使用频率、schema 成本都无关。测试里只有点状断言（`EpisodicRecall` 必须在 CORE、设计画布工具必须不在 CORE），没有一条门在管"凭什么进 CORE"。

`docs/architecture/tool-system.md` §Core/Deferred 双层架构写的是"共 15 个"（表里列了 14 个）、"registry 注册 108 个 native ToolModule"——实际是 23 个和 130 个，文档两处都陈旧。

逐工具现状（**真 tokenizer 值**；用量 = 生产库 + dev 槽去重执行数合并；「去向」= SLIM2 的处置）：

| 工具 | 真 token | 用量 | 进 CORE 时间 | 去向（SLIM2） |
| --- | ---: | ---: | --- | --- |
| TaskManager | **1995** | **0** | 早于 06-26 | → deferred |
| Grep | 600 | 46 | 早于 06-26 | 留 CORE |
| WebSearch | 588 | 1302 | 早于 06-26 | 留 CORE |
| Bash | 532 | 1013 | 早于 06-26 | 留 CORE |
| MemoryWrite | **481** | **0** | 早于 06-26 | → deferred |
| Write | 348 | 313 | 早于 06-26 | 留 CORE |
| Edit | 347 | 183 | 早于 06-26 | 留 CORE |
| Glob | 318 | 184 | 早于 06-26 | 留 CORE |
| delegate_task | 318 | 32 | 08-09 | 留 CORE |
| recommend_capability | 309 | 4 | 早于 06-26 | 留 CORE（体积小，且是能力自诊入口） |
| Read | 262 | 706 | 早于 06-26 | 留 CORE |
| ListDirectory | 247 | 96 | 早于 06-26 | 留 CORE |
| EpisodicRecall | **243** | **0** | 07-13 | → deferred |
| AskUserQuestion | 240 | 25 | 早于 06-26 | 留 CORE（唯一问人通道，延迟一轮直接伤交互） |
| Blob | 191 | 26 | 早于 06-26 | 留 CORE |
| Append | **178** | 1 | 早于 06-26 | → deferred |
| MemoryRead | **146** | 4 | 早于 06-26 | → deferred |
| ToolSearch | 125 | 69 | 早于 06-26 | 留 CORE（没它模型无法起步） |
| steer_task | **123** | **0** | 08-05 | → deferred |
| cancel_task | **103** | **0** | 08-05 | → deferred |
| Skill | 69 | 30 | 早于 06-26 | 留 CORE |
| ExternalSearch | 59 | **0** | 08-12 | 留 CORE（08-12 才加，窗口不足） |
| task_status | 55 | 61 | 08-05 | 留 CORE |

`WebSearch` / `Skill` 带 `dynamicDescription()`，静态实算会低于真实下发（ATT1 测 WebSearch 真实 1233，本地静态 855，差 378 是运行时拼接的）。

### 使用频率的取数口径与两条修正

- 生产库 `~/.code-agent/code-agent.db`：06-17 22:33 ~ 08-14 10:49，4563 次去重执行。
- dev 槽 `~/.code-agent-dev/code-agent.db`：08-08 ~ 08-14，185 次。爸自 08-04 起主要驾 Dev 槽，所以生产库近 30 天几乎无新数据（Bash 11 / Read 8 / ToolSearch 8），**必须两库合并看，只看生产库会把最近的多 agent 使用全漏掉**（`delegate_task` 32 次、`task_status` 61 次全在 dev 槽）。
- **工单说"origin 列现在有值，可按 desktop/cli 分平面看"——实测不成立**：4563 行里 4555 行 `origin` 是 NULL，只有 8 行是 `cli`。该列是后加的，存量没回填，分不了平面。

记录点覆盖面已核：`createToolExecutionLedger` 只有一个调用方，在 `toolExecutor.ts:1075` 的中央派发路径上，所有走 toolExecutor 的工具都会落账（唯一旁路是命中工具缓存的早返回，`TaskManager` 这类写工具不可缓存）。dev 槽里 `delegate_task` / `spawn_agent` 都有记录，证明多 agent 工具不在记录盲区里——所以 `TaskManager` 的 0 是真的 0。

### 130 个注册工具、100 条索引、19 个真黑洞

`registry.register()` 在 `tools/modules/index.ts` 里调了 130 次，`DEFERRED_TOOLS_META` 100 条，`CORE_TOOLS` 23 条。

**35 个已注册工具，模型 `select:<name>` 拿不到它自己。**

> 判据修正（ATT8 施工时）：本节初稿用手写的「名字/别名集合匹配」估出 32 个。改用真实的
> `ToolSearchService.selectTool()` 逐个探测后是 **34 个查无此名 + 1 个串到别人**。差异来自
> alias 解析——`select:web_fetch` 实际返回的是 `WebFetch`（另一个 952 token 的统一工具），
> 手写匹配把它算成了命中。**「查得到」和「查到的是它自己」是两件事，只有真调一次才分得清。**
> 另外三个（`xlwings_execute` 638、`pdf_compress` 293、`mcp` 262）也是被近似匹配漏掉的。

逐条判定后分三类（全部核过在 `registry.register()` 列表里，不是没注册）：

**A 类 · 门面覆盖，设计内隐藏（15 个）** —— 子工具刻意不进索引，能力由门面工具暴露，少一个工具进表。判据是门面实现直接 import 了子工具的 `execute*`：

| 子工具 | 门面 |
| --- | --- |
| `task_create` / `task_update` / `task_get` / `task_list` | `TaskManager` |
| `plan_read` / `plan_update` / `plan_recover_recent_work` | `Plan` |
| `enter_plan_mode` / `exit_plan_mode` | `PlanMode` |
| `mcp` / `mcp_add_server` | `MCPUnified` |
| `read_docx` | `ReadDocument` |
| `xlwings_execute` | `ExcelAutomate` |
| `pdf_compress` | `PdfAutomate` |
| `web_fetch` | `WebFetch`（即那个「串号」——本体 443 token 无人直达，能力由统一版承接） |

**B 类 · strict skill 直接注入（1 个）** —— `exit_role_flow`，只被 `create-role` / `edit-role` 两个 strict skill 使用。strict skill 的工具集直接注入、不走 ToolSearch，故不要求进索引。这也解释了它为什么没触发已有的那道 skill 门（该门跳过 strict skill）。

**C 类 · 真·不可达（19 个）** —— 注册了、能执行，但模型既看不见也搜不到，也没有门面代理，**能力等于不存在**：

```
655 visual_edit       509 teammate          434 request_directory
406 ppt_edit          370 local_speech_to_text  282 diagnostics
272 plan_review       261 space_create      242 read_tool_result_archive
228 task_output       207 declare_deliverables  196 SkillCreate
187 collect_agent     176 git_commit        163 space_query
161 kill_shell        150 git_diff          124 git_worktree
 94 space_list
```

现有的防复发门（`builtinSkillToolDiscoverability.test.ts`，#608/#609 建）只管一件事：内置 skill 的 `allowedTools` 必须落在 `CORE ∪ META` 里。**没有任何门管"注册了的工具必须可发现"**，C 类这 19 个就是从这个缺口漏下去的——它们不被任何 skill 声明，所以那道门根本扫不到。

**ATT8 已补上这道门**：`tests/unit/tools/toolRegistrationDiscoverability.test.ts`，以 registry 注册表为真源，逐个问「模型怎么够得着它」，四条合法到达路径（CORE / select 命中自己 / 可发现的门面代理 / strict skill 注入），C 类 19 个进棘轮基线只许变短。

### ToolSearch 召回质量：select 稳，关键词不稳

实现是纯词法打分（name / shortDescription / tags / aliases 匹配），无向量、无模糊，默认 `maxResults=5`。三种查询模式：`select:<name>` 直取、`+word` 必含、裸关键词。

生产库 69 次真实调用的证据：

- **状态全绿但只有 58% 转化**：69 次全部 `status=success`（"跑成功了"不等于"找到了"），其中 40 次在同会话 5 分钟内真的调到了延迟工具。
- **73% 一击命中**：49 个会话里 36 个只搜一次，11 个搜两次，1 个搜三次，**1 个连搜 8 次**。
- 连搜 8 次那个会话的查询词是同一个意图换了六种说法：`设计画布 上传图片 导入素材 添加图片节点 design canvas image import` → `addImage image node canvas local existing asset place upload` → `画布 放置本地图片 素材 addImage 已有图片` → `扩图 outpaint 扩展画布 AI 补全 9:16 图片扩展` → …最后靠 `select:image_process` 拿到。**这是关键词召回失败、靠名字兜底的现场。**

结论分两半：**模型不知道名字时，关键词召回不可靠；模型知道名字时，`select:` 100% 稳**。而名字从哪来——每轮随静态系统提示下发的 deferred 名字索引（`getDeferredToolsSummary`），100 条、真 1772 token、均 17.7 token/条（÷3 口径为 1320/13.2，中文多故低估）。这决定了减半方案的形状。

## 路径 A：降低单个 schema 体积

**系统性判断：#1130 已经砍完描述那一轮，剩下约七成在参数里（真值口径 67.4%）。** 典型形态（`Grep`，参数真 532 token、占它整体 88.7%）：

```ts
pattern: {
  type: 'string',
  description:
    'Regex pattern to search for. MUST be a string. ' +          // ← type 字段已经声明了
    'Examples: "function\\s+handleClick" (function definitions), ' + // ← 三个示例
    '"import.*from" (import statements), "TODO|FIXME" (comments). ' +
    'Escape special regex chars: . * + ? [ ] ( ) { } | \\ ^ $',
},
```

每个参数 2~4 句、带示例、并把 `type` 已经声明过的类型再用 `MUST be a string` 复述一遍。11 个参数都这样写。

| 候选 | 现状 token（÷3） | 建议动作 | 预估节省（÷3） | 风险 |
| --- | ---: | --- | ---: | --- |
| TaskManager 参数 | 1607（描述另 625） | 六动作扁平联合体，20+ 属性靠 `[action]` 前缀互斥。收敛示例段（描述里 11 条示例）+ 把 `tasks[]` 子对象的重复 property description 合并 | 600~900 | 中：改的是模型唯一的任务契约来源 |
| Grep 参数 | 740 | 删示例、删 `MUST be a string` 复述、`limit`/`head_limit` 别名二选一 | ~300 | 低 |
| WebSearch 参数 | 706 | 同上 | ~250 | 低，但它是用量第一（1302 次），必须 A/B |
| MemoryWrite 参数 | 619 | 0 使用，若不整体挪 deferred 则先砍参数 | ~250 | 低 |
| Write / Glob 参数 | 387 / 375 | 同上 | ~200 | 低 |
| **全表规范** | 参数占 67.4%（真） | 立一条"参数描述不写示例、不复述 type、别名不双写"的写法规范 + 进注意力棘轮 | **1500~2500** | 中：需要一次性改 23 个 schema，且得有门守住不反弹 |

**本表数字仍为 ÷3 口径**（英文被高估约一倍），真实收益约为表列值的一半——SLIM3 施工时会用真 tokenizer 重估。相对排序不受影响。

全表规范那条是本路径的主菜——单点砍 Grep 省 300，立规范砍全表省 1500~2500，且是一次性投入换永久棘轮。

## 路径 B：减少进表数量

**核心算术**：一个工具留在 CORE 每轮花它的完整 schema（真值 55~1995 token）；挪进 deferred 每轮只花名字索引里的一行（均 17.7 token），模型要用时 `select:` 一次拉全量。代价是一个额外往返，收益是每轮省下 3~113 倍。

| # | 工具 | 真 token | 用量 | 动作 | 风险 |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | **TaskManager** | **1995** | 0 | 从 `CORE_TOOLS` 删一行即可——**它已经同时登记在 `DEFERRED_TOOLS_META` 里**，是 23 个 CORE 工具里唯一一个 | 中，见下方"反证" |
| 2 | MemoryWrite | 481 | 0 | 挪 deferred，需补一条 meta | 中：记忆是产品叙事的一部分，"模型不主动写记忆"本身可能是另一个问题 |
| 3 | EpisodicRecall | 243 | 0 | 同上 | 中：`toolDefinitions.test.ts:241` 有一条断言钉死它必须在 CORE，要连断言一起升级 |
| 4 | Append | 178 | 1 | 挪 deferred | 低：Write/Edit 覆盖绝大多数写场景 |
| 5 | MemoryRead | 146 | 4 | 与 MemoryWrite 同批（半条链路没意义） | 中 |
| 6 | steer_task + cancel_task | 226 | 0 | 挪 deferred | 低：同批的 `task_status` 61 次、`delegate_task` 32 次在用，这两个是补充动作 |
| — | **合计挪出** | **3269** | | 名字索引相应涨 **+160**（1772→1932） | — |
| — | **净省/轮** | **3109** | | 占工具 schema 桶 **41.5%** | — |

> ÷3 口径下这张表算出的是「省 3805」，实测真值 **3109**，少 29%。绝对值缩水但比例反而更高
> （41.5% vs 36.7%），因为分母也一起缩了。

**SLIM2 已全部落地**（`CORE_TOOLS` 23 → 16）。实测复核：`CORE` 7877 → 4608，名字索引 1772 → 1932，净省 **3109 token/轮**。

不建议动的：

- **ExternalSearch（95, 0 次）**：08-12 才进 CORE，两天窗口，0 使用不构成证据。
- **MemoryRead（222, 4 次）**：与 MemoryWrite 同一能力面，要动一起动，别拆半条链路。
- **Blob（278, 26 次）/ recommend_capability（238, 4 次）**：低频但体积小，性价比不如路径 A。
- **AskUserQuestion（377, 25 次）**：低频但是唯一的问人通道，延迟一个往返直接伤交互。

一手参考（Claude Code 自身，本会话可直接观察）：它把 `WebFetch` / `WebSearch` / `TaskCreate` / `TaskList` / `TaskUpdate` / `NotebookEdit` / `EnterPlanMode` / `ExitPlanMode` 全部放在 deferred，上下文里只留工具名一行——**任务管理工具族被 defer 是它的既定做法**，这与候选 #1 同向。

## 反证：TaskManager 的 0 使用可能不是"不需要"

按"低使用率可能是 bug 的产物，不是该删的证据"这条纪律，逐条查了三种解释：

1. **记录盲区** —— 排除。记录点在中央派发路径上，dev 槽里同族工具都有记录。
2. **工具坏了** —— 未发现证据。ATT1 报告里那句 `TaskManager not initialized. Call initialize() first.` 来自 `src/host/task/TaskManager.ts`（后台 agent 运行编排器），**与 `TaskManager` 工具是同名不同物**：工具在 `tools/modules/planning/taskManager.ts`，是 taskCreate/Get/List/Update 的门面，不碰那个类。ATT1 那句话说的是 `delegate_task` 的后台运行，不能拿来判工具死活。
3. **引导断了** —— 有嫌疑，未确证。`src/host/prompts/rules/taskManagement.ts` 是 5.9KB 的 TaskManager 使用指导（何时用、生命周期、证据门、调用示例），**但它不进运行时提示词**：`TASK_MANAGEMENT_RULES` 全仓只被 `promptIndex.ts` import 一次（供设置页列出/覆盖用），`builder.ts` 从不消费它。同目录 16 个规则块里有 4 个是这个状态（`taskManagement` / `taskClassification` / `toolDecisionTree` / `toolUsagePolicy`），另外 12 个的"引用"其实是 `cloud/builtinConfig.ts` 里的同名常量，不是同一份文本。`builder.ts:93` 自己的注释已经承认了同类事实——"原 outputFormat 静态规则均未接入运行时 prompt"。

也就是说：**TaskManager 的 2249 token schema 每轮都发，而告诉模型什么时候该用它的那 5.9KB 一次都没发过。**

时间线对不上，不能下因果结论：任务停写在 06-11，而删掉 `rules/index.ts` 死 barrel 的 #689 是 07-25，且该 PR 的 typecheck 证明它当时**已经**是死的。规则块什么时候脱钩的、06-11 那道坎是不是同一件事，本单没查出来。

所以候选 #1 有两条路：

- **A 路（直接挪）**：立刻省 2249 token/轮，改动一行。赌的是"这个能力本来就没人用"。
- **B 路（先修引导再测）**：把 `rules/taskManagement.ts` 接回运行时提示词（约 +1900 token/轮），跑一段时间看模型是否开始用；用了就说明它一直是被憋着的，留在 CORE；不用再挪。代价是先加钱再省钱，且要等观测窗口。

**对标调研后的结论：两条都不完整，正确答案是 A+**，见下节。

## 对标：13 个成熟产品的任务工具怎么做

三路并行调研。证据分三档：**本机二进制 `strings` 逐字提取**（Claude Code v2.1.232 / Codex v0.147.0 / Kimi CLI / Grok CLI，含运行时门控代码原文，档位 A）；**开源读 GitHub 源码**（Roo Code / OpenHands / Goose / Cline，档位 A）；**闭源走 system prompt 泄露合集**（Cursor / Windsurf / Manus / Devin，已核提交日期，档位 B）；另加 Amp、Lovable 两个反差样本。Gemini/Antigravity 的工具 schema 未打包进本地二进制，未获取，不编造。

| 产品 | 形态 | 引导写在哪 | 是否常驻 |
| --- | --- | --- | --- |
| Claude Code | **两套互斥**：单人 `TodoWrite`（伞形）／团队 `TaskCreate/Update/List/Get`（拆 4 个） | description，且**按模型切长短两版** | **两套全 `shouldDefer:true`** |
| Codex CLI | 单一伞形 `update_plan` | **全压系统提示词**，大段专节 + 好/坏 plan 各 3 例 | 常驻（配置层静态开关） |
| Kimi CLI | 单一 `TodoList`，参数有无复用三态 | description，独有「Avoid churn」防滥调段 | 策略门控，非按需 |
| Grok CLI | 拆 2 个：`TodoWrite` + `CreatePlan`（落 `.grok/plan.md`） | CreatePlan 的 description 很细 | 未获取门控证据 |
| Amp | `todo_write` + `todo_read` | 工具里 | 字段结构几乎逐字照抄 Claude Code |
| Cursor | 单一伞形 `todo_write` | 系统提示 + 工具都写 | 常驻，**只对 Claude 模型开启** |
| Roo Code | 单一伞形 `update_todo_list` | description，含 When to Use / When NOT to Use | 疑似常驻 |
| OpenHands | 单一伞形 `TaskTrackerTool` | description 约 120 行，含 3 正例 + 2 反例 | 确证常驻（写死默认预设） |
| Goose | 单一伞形 `todo_write` | 只有一句 WARNING | 默认开启，可关 |
| Cline | **不用工具**，模型直接编辑 markdown 文件 | — | 默认开启 |
| Windsurf | `update_plan`，由「plan mastermind」子代理写 | — | 落 `plan.md` 真文件 |
| Manus | **无专门 todo 工具**，Planner 出步骤 + 通用文件工具改 `todo.md` | — | 文件形态 |
| Lovable | **零任务清单机制** | — | — |

### 三条结论

**1. 形态不用改。** 伞形是主流（开源四家 0:4 全伞形，Codex/Kimi/Cursor 也是）。少数拆开的（Claude Code 团队模式、Grok）拆的依据是**职责不同**，不是把一个工具的动作拆开。Neo 的伞形结构没问题。

**2. 引导写在哪，由"常不常驻"决定。** 表面两派，对齐"是否常驻"一列就看出规律：常驻的（Codex、Cursor）引导放系统提示词——工具反正每轮在，成本一致；按需加载的（Claude Code）引导必须写进 description——工具没到场就不发引导，到场时一起来。

> **Neo 是第三种，也是唯一没有道理的那种：工具常驻付全价，引导写在一个从不发送的文件里。**两派的好处一个都没占到。

**3. 参数复杂度 Neo 最重，因为一个工具扛了三个产品的职责。** 对标产品参数普遍 1~2 个（Roo Code `todos`、Goose `content`、Claude Code TodoWrite `todos`、Codex `explanation`+`plan`），Neo 是 31 个。按来源分：

- 个人待办清单：subject / description / activeForm / priority / status —— 对标 Claude Code 的 `TodoWrite`
- 团队协作任务板：owner / addBlocks / addBlockedBy / parentTaskId —— 对标 Claude Code 的 `Task*` 家族，**人家是另一套互斥工具，单人会话根本不出现**
- 桌面任务生命周期：desktopAction / desktopSnoozeHours —— **13 个对标产品里没有任何一家有**
- 证据门：completionEvidence / blockedReason / cancelReason —— 我方独有优势

Claude Code 的二进制里，`TodoWrite` 是 `isEnabled(){return !B1() && !Fde()}`、`Task*` 家族是 `isEnabled(){return B1() && !Fde()}`——**互为反条件，永不同时出现在工具表里**。Neo 把两者焊死在一个 schema 里，单人对话也照发团队字段。

最干净的一刀：**`tasks[]` 批量分支占 627 token，13 个子字段里 11 个与顶层同名同义**（taskId/subject/description/activeForm/status/completionEvidence/blockedReason/cancelReason/priority/owner/metadata），剩下 `id`/`content` 还是 `taskId`/`subject` 的别名。为支持 replace/patch 批量模式，同一套字段复述了第二遍。

### 三条外部证据

1. **Manus 自己算过账后掉头**：内部发现约 1/3 动作预算被 todo 维护吃掉，转向 Planner 代理 + 按需注入。（第三方博客转述 2025-10-15，无官方一手确认，**档位 C**，方向与 Manus 官方博客的技术动机自洽。）
2. **Cursor 官方论坛版主：TODO 工具 "currently only enabled for Claude models"**——别的模型调不好，只在回复文本里干写清单不调工具。**这条直接解释 Neo 的 0 使用**：默认模型 `deepseek-v4-flash` 正是最不容易主动调元工具的一档。而 Claude Code 面对同一问题的解法不是关掉，而是**给弱模型更长的引导**。
3. **用户点踩榜第一是"标完成 ≠ 真完成"**：Cursor 自家论坛 2025-07 到 2026-06 持续投诉，清单堆 60+ 条不清理、做完仍显示 pending，官方承认是已知问题。好评三大主题全是"透明度/可审查/把模型拽回正轨"，**没有一条夸清单本身**。

### 我方已领先，别抄回去

`completionEvidence` 证据门（ADR-050）是真闸：`buildTaskEvidenceUpdates` 是 update/replace/patch 三条写路径的单一收口点，缺证据直接返回 error。这恰好是 Cursor 栽了近一年的坑。**瘦身时别砍。**

### 候选 #1 的最终形状：A+

1. **挪 deferred**（省 2249/轮）——没有第二家用 2249 token 的伞形工具常驻，且 72% 是参数结构。
2. **把引导从 `rules/taskManagement.ts` 搬进工具 description**——B 路的形态是错的，没有一家按需加载的产品把引导放常驻系统提示。
3. **参数瘦身，先砍 `tasks[]` 那 627 token**；再照 Claude Code 的 `isEnabled()` 互斥思路把团队协作字段从单人会话摘出去。
4. **引导按模型给长短两版**（Claude Code 二进制里的做法）。
5. **补"你该建任务了"的主动 nudge**——照 Goose（清单为空时也注入）或 Cline（`remindClineInterval: 6` 计数器）。同时抄 Kimi 的「Avoid churn」段防反向翻车。

子 agent / skill 零影响：`deferredToolPreload.ts:109` 已做"显式 allowlist 里的非 core 工具一律预载"，`coreAgents.ts` 和内置 skill 里声明 TaskManager 的路径照常拿得到。

**这单答不了的更根本问题**：`session_tasks` 41 个会话 79 行任务，created_at 与 updated_at 都停在 2026-06-11，Dev 槽 0 行——**右侧任务面板真机上已空了两个多月**。上面五步是让这个能力"便宜地活着"，它是否还作为产品卖点继续投入是另一个层面的决定。

## 风险与红线

- **本单最大的翻车风险是牺牲可发现性**：模型找不到工具的代价远大于 schema 省的钱。上面所有候选都建立在"名字索引照发"的前提上——`getDeferredToolsSummary` 那 1772 token（真）是地基，**不在减半范围内**。
- **名字索引不是无条件下发的，这是候选清单的第二个前置条件**：`<deferred-tools>` 块（`messageBuild.ts:392`）有三道闸——`enableToolDeferredLoading` 关掉、artifact 修复/简报模式、以及走 `appendPromptBlockWithinBudget` 在系统提示超预算时**整块丢弃**（会记进 context health 面板，不是静默）。工具留在 CORE 时这些闸门伤不到它；一旦挪进 deferred，闸门一关它就彻底消失。挪之前要确认这三种情况下的行为可接受，或给被挪走的工具加一条豁免。
- **减半之前应先补一道门**：`registry.register()` 注册的工具必须落在 `CORE ∪ DEFERRED_TOOLS_META` 里。现在 19 个已经漏进黑洞了，再往 deferred 挪只会把更多能力推向这个缺口。这道门是候选清单的前置条件，不是可选项——**ATT8 已落地**。
- **关键词召回本身别当依赖**：58% 转化率、一个会话连搜 8 次的现场都说明它不可靠。候选清单只依赖 `select:<name>`，不依赖搜索质量——如果将来要靠关键词召回来砍名字索引，那就是另一单，且必须先修召回。
- 若最终改动落到提示词或注入点，`node scripts/attention-budget-ratchet.mjs` 必须绿；改注入点要同步 `docs/architecture/injection-panorama.md` 与棘轮基线。
- 收尾判据：合并后那轮 `Main Full Gate (post-merge combo check)` 绿，不是 PR 绿。

## 顺带查出、不在本单范围的三件事

1. **`src/host/prompts/rules/` 16 个规则块全部不进运行时提示词，但在设置页可见可改**——用户改了不生效的幽灵设置面。值得单开一张。
2. **`docs/architecture/tool-system.md` 的 Core/Deferred 段陈旧**：写 15 个 CORE（列了 14）、108 个 ToolModule，实际 23 / 130。
3. **`web_fetch`(443) 与 `WebFetch`(952) 两份抓取工具并存**，前者不在索引里、后者 471 次使用，疑似遗留未清。

## 证据与口径

- token 口径与 ATT1 一致：`{name, description, parameters}` 的 JSON 序列化字符数 ÷ 3，四舍五入。量尺脚本直接 import 全部 120 个 `*.schema.ts`（0 个解析失败，得到 130 个 schema 对象），不启动 registry。
- 与 ATT1 真实下发的对账：10 个 Top 工具里 7 个完全一致（Grep 855 / MemoryWrite 745 / Write 567 / Edit 519 / Glob 451 / AskUserQuestion 377 / Read 376）。三个有差：`TaskManager` 2249 vs 2502、`WebSearch` 855 vs 1233 是 `dynamicDescription()` 运行时拼接；`Bash` 730 vs 715 涨了 15，正是 #1131 给 Bash 补的可选 `description` 参数。**差异全部可解释，口径可信。**
- 使用频率：`tool_execution_events` 按 `execution_id` 去重（该表每次执行落 begin + complete 两行，直接 `count(*)` 会翻倍）。生产库 + dev 槽合并。
- 证据档位：schema token 与工具注册状况为 A（源码实算 + 与真实请求体对账）；使用频率为 A（生产真库多信源交叉：工具账本 + `session_tasks` 表）；ToolSearch 召回质量为 B（69 次真实调用的行为学证据，非受控实验）；"引导断了"为 B（静态可达性分析，未做运行时变异验证）。
- 本单只列不改，未动任何源码。
