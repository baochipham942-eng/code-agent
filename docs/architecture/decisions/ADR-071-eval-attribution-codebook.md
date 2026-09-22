# ADR-071：评测归因码本（问题分类 · 归因轴 · 风险定级 · 待回归）

- 状态：**待拍板**（刀 1 只出 ADR 与对齐稿；爸点头后才开刀 2）
- 工单：N-EVAL-ATTRIBUTION-CODEBOOK（wave 8 评测闭环线，blocked-by N-EVAL-REPORT-BREAKDOWN）
- 相关：ADR-063（上线后评测回流四道闸）、N-EVAL-JUDGE-ABSTAIN（#1821）、N-EVAL-JUDGE-HUMANGOLD（#1823）、N-EVAL-REPORT-BREAKDOWN、N-EVAL-POSTLAUNCH-REFLOW
- as-built 基线：**origin/main@8459da0b3**（#1823 合入后。本文件所有 `标识符 @ 文件:行号` 均从该 commit 核出，不是从工作树）
- 来源：爸 09-14 拍板，借鉴《AI 应用测评培训课》（数字化转型研习社）第 09/22/23 节

## 背景：Neo 已经有几套失败语言，不能再加第八套

08-28 的 N-EVAL-BLUEPRINT 已经警告过「一次失败三个名字」。这次先把现有的全数出来，数完发现是 **六套**，不是三套，而且其中两套是活标本。

### 现状全表（@8459da0b3）

| # | 语言 | 取值（个数） | 定义处 | 生产消费方 | 生产是否真读 |
|---|------|------------|--------|-----------|-------------|
| 1 | **表现轴 failcode** | 7 码：`crash` / `timeout` / `max_steps` / `loop_suspect` / `tool_error_storm` / `missing_artifact` / `wrong_output`（按 `priority` 取唯一最高码） | `.claude/eval-failcodes.yaml`（`version: 1`，100 行，`codes[].code/label/priority/match/dispositions/issue`） | `classifyFailure @ src/host/testing/failureCodes.ts:277`；读者 6 处：`testResultFailure.ts:15`、`postLaunchScorer.ts:184`、`comparator/comparisonReport.ts:8`、`reportGenerator.ts:10`、`evaluation.ipc.ts:31`、`scripts/postlaunch-score.ts:24` | ✅ 真读 |
| 2 | **处置轴 dispositions** | 4 值：`retryable` / `not_in_denominator` / `known_issue`（须配 `issue:` URL，展开成 `known_issue:<url>`）/ `needs_human` | 白名单 `validateDefinition @ src/host/testing/failureCodes.ts:133`；另有三条**不写在 yaml 里的固定注入** `addFixedDispositions @ failureCodes.ts:256`（`failureStage` 为 `infra`/`cost_limit` → `not_in_denominator`；`configuration` → `needs_human`） | `assertFailureDispositionConsistency @ failureCodes.ts:298`；契约 `EvalFailureClassification.dispositions @ src/shared/contract/evaluation.ts:231` | ✅ 真读 |
| 3 | **状态轴 TestStatus** | 9 态：`pending` / `running` / `passed` / `failed` / `skipped` / `partial` / `infra_excluded` / `cost_exceeded` / `not_run` | `src/host/testing/types.ts:36` | 全链路（runner / 报告 / 对照 / 基线） | ✅ 真读 |
| 4 | **阶段轴 failureStage** | **无枚举，类型是自由 `string`**；实际在用 6 值：`configuration` / `infra` / `cost_limit` / `timeout` / `telemetry_replay_gate`（+ web 侧 `context.stage` 透传） | `types.ts:495`（`failureStage?: string`）；赋值点 `testRunner.ts:750/765/1030/1040/1044/1049`、`testRunnerTelemetryReplay.ts:55`、`agentEngineFailureRecorder.ts:63` | `failureCodes.ts:241`（进 `match`）、`:261`、`:274`（进 dispositions）；跨 28 处引用 | ✅ 真读，但**无类型约束**——拼错一个字母不报错，只是静默不匹配 |
| 5 | **轨迹偏差 DeviationMarker.type** | 声明 6 值：`wrong_tool` / `unnecessary_step` / `missed_step` / `wrong_args` / `hallucination` / `loop`；**检测器只产 4 值**，`wrong_tool` 与 `missed_step` 全仓零产出 | 类型 `types.ts:1021`；产出 `DeviationDetector @ packages/internal/evaluation-center/src/host/evaluation/trajectory/deviationDetector.ts:15` | **生产零消费方**。唯一调用者是 smoke 脚本 `packages/internal/evaluation-center/scripts/smoke-attribution.ts:111` | ❌ 装好没接电 |
| 6 | **轨迹归因 FailureCategory** | 7 码：`tool_error` / `bad_decision` / `missing_context` / `loop` / `hallucination` / `env_failure` / `unknown` | `types.ts:1075`；规则映射 `mapDeviationTypeToCategory @ trajectory/attribution/ruleAttributor.ts:25`；LLM 兜底白名单 `llmAttributor.ts:28` | **生产零消费方**。出口 `FailureAttributor @ trajectory/attribution/failureAttributor.ts` 唯一调用者是同一个 smoke 脚本 `:112` | ❌ 装好没接电 |

### 5 与 6 为什么没接电（根因在一行代码）

`testRunner.ts:1080-1084` 是轨迹线唯一的生产入口，它只做了半件事：

```ts
if (completedExecution && this.config.enableTrajectoryAnalysis) {
  const { TrajectoryBuilder } = await import('.../trajectory/trajectoryBuilder');
  const builder = new TrajectoryBuilder();
  result.trajectory = builder.buildFromTestResult(result, testCase);   // 只建，不检测、不归因
}
```

而 `trajectoryBuilder.ts:45` 自己留了注释 `// filled later by DeviationDetector`——那个 later 至今没有到来。`Trajectory.deviations @ types.ts:1054` 在生产里恒为空数组。`enableTrajectoryAnalysis @ types.ts:723` 还是个可选布尔，默认关。

所以 **Neo 目前在生产路径上只有 1/2/3/4 四套语言在跑**，它们全部描述「运行怎么坏的」（表现 + 处置 + 状态 + 阶段），**没有任何一套回答「谁的责任」**。这就是归因轴要填的空。

### 划界：两个同名不同物，本 ADR 不归并

- `AgentEngineFailureCategory @ src/shared/contract/agentEngine.ts:69` —— 产品运行时的引擎失败分类，用户面。
- `CuaFailureCategory @ src/host/mcp/cuaFailureStats.ts:19` —— computer-use 工具的错误分类。

两者都不在评测链路上，名字撞车但语义不同。本 ADR 的码本**只管评测链路**，不动它们，也不要求它们改名。

## 决策

### D1 · 六类问题分类：不新建枚举，落在 failcode 的 `category:` 标签上

课程的「问题分类」= 坏的形态（报告端语言），与 Neo 的表现轴 failcode 是同一层；课程的「维度」= 评的视角（设计端语言），与 Neo 的判官五维是同一层。课程第 09 节 3.1 映射总表的六类官方名称是：**内容错误 · 语义偏差 · 合规风险 · 场景不匹配 · 回复异常 · 稳定性问题**。

做法：给 `.claude/eval-failcodes.yaml` 的每条加 `category:` 标签，取值就是这六类（不是新表、不是新文件、不另造名字），并按需补缺的类。映射表：

| 课程六类（官方名） | 课程定义（第 22 节二） | Neo 现有 failcode | 归位理由与差距 |
|---|---|---|---|
| **内容错误** | 输出与事实或业务口径不符：事实错误 / 幻觉编造 / 口径错误 | `wrong_output` | 部分对应。课程判定要点是「必须有明确的对照依据（事实来源或口径文档）」，而 Neo 的对照依据是题目自带的 expectation，**没有业务口径文档这一层**——桌面产品无「官方口径」对象，这一子类在 Neo 不成立 |
| **语义偏差** | 答的不是用户问的；输出质量高不构成免责 | **无** | 🔴 缺。判官维 `task_completed`（`AI_REVIEW_DIMENSIONS @ src/host/testing/judge/dimensions.ts:3`）判的正是这个，**判完不落 failcode**，于是进不了 `failureDistribution` |
| **合规风险** | 触碰法律 / 监管 / 平台红线，一票否决 | **无专码**，但机制已在：`safety` split（`ci/sampleSplits.ts:34`）+ `no_forbidden_tool_call` 断言（`types.ts:860`、`assertionEngine.ts:1074`） | 🔴 **缺码不缺机制**。后果是合规失败目前混在 `wrong_output` 的计数里，报告上看不出「有几个合规问题」——而这恰是唯一一类一票 P0 的问题 |
| **场景不匹配** | 技术上没错，但身份 / 语气 / 行为方式与场景要求冲突：人设出戏、越界硬答、立场错误 | **无** | 🔴 缺。判官维 `confirmed_before_acting`（该问不问就动手）与 `no_extra_changes`（越界改了不该改的）判的是这个，同样不落 failcode |
| **回复异常** | 形式层面不可用：格式错乱 / 截断 / 拒答异常 | `missing_artifact`（完整性缺漏这一子类） | 部分对应。`missing_artifact` 只覆盖「产物没生成」，**格式错乱与拒答异常两个子类 Neo 没有**。`max_steps` 在用户眼里也表现为截断，但它的根因是不收敛，归稳定性 |
| **稳定性问题** | 同题不同果 / 响应超时 / 服务报错 | `crash`（服务报错）、`timeout`（响应超时）、`tool_error_storm`（服务报错）、`loop_suspect`（不收敛）、`max_steps`（不收敛） | ✅ Neo 最全的一类。但「同题不同果」这一子类 Neo 走的是 pass^k 与配对 sign test，**是统计口径不是 failcode**，不会出现在问题分布里 |

**一句话读这张表**：Neo 的 7 个 failcode 里 **5 个挤在「稳定性问题」一类**，内容错误、回复异常各 1 个，**语义偏差 / 合规风险 / 场景不匹配三类完全空白**。Neo 的失败语言严重偏向运行层——这与背景段「四套在跑的语言全部描述运行怎么坏的」是同一件事在问题分类侧的投影。

补三码提案：`intent_drift`（语义偏差）、`compliance_risk`（合规风险）、`scenario_mismatch`（场景不匹配）。前两者的 `match` 走判官维度、后者走 split + 断言名，都不是正则——**这是一个新机制**（现有 `match` 只认 `failureReason` / `failureStage` / `status` / `stderr` 四个文本字段，`failureCodes.ts:113`），要不要开见待拍板 Q2。

### D1 附 · 课程要点一在 Neo 的落法（准确性还是鲁棒性，看触发条件）

第 09 节 3.2 要点一：内容错误与语义偏差这两种**形态**，既可能损害准确性也可能损害鲁棒性，判定规则是**看触发条件**——正常输入就错归准确性，输入变化或干扰才错归鲁棒性。

Neo 里这条不用新建任何东西，split 已经是它：同一母题在 `held-in`（原题）过、在 `held-out`（同构换皮）挂 = 鲁棒性问题；`held-in` 就挂 = 准确性问题。这也说明 N-EVAL-HELDOUT-STRUCTURAL 那一单不只是防过拟合，它同时是**鲁棒性维度在 Neo 的唯一判定装置**。

要点二（合规是独立王国，不与其他维度交叉）对应 D3 的一票 P0；要点三（回复异常是易用性视角下最常见的坏形态，两套体系粒度不同）说明 `category` 只能标问题分类，不能拿去当维度用——Neo 的维度语言是判官五维，两者不合并。

### D2 · 四类归因作为新一轴，加在 failcodes.yaml 的 `attribution:` 字段

```yaml
  - code: timeout
    label: 运行超时
    priority: 600
    attribution: model_capability        # ← 新字段，与 dispositions 并列
    category: stability                  # ← D1 的新字段，取值为课程六类（这里是「稳定性问题」）
    dispositions: []
```

四类取值：`user_input`（用户输入）/ `model_capability`（模型能力）/ `scenario_fit`（场景适配）/ `system_config`（系统配置）。

- **校验复用现成通道**：`validateDefinition @ failureCodes.ts:90` 已经在做白名单校验（dispositions 就走这条），加一个 `attribution` 白名单是同一个函数里加一段，不需要新校验器。
- **输出复用现成契约**：`EvalFailureClassification @ src/shared/contract/evaluation.ts:231` 加一个 `attribution?: string`，与已有的 `code` / `dispositions` / `symptoms` 并列。`classifyFailure` 返回时从命中的最高优先码上取（`failureCodes.ts:292` 已经在这么取 `code`）。
- **为什么不新表**：归因是「这个 failcode 通常是谁的错」的属性，不是独立实体。新表会立刻变成第七套语言，而且和表现轴一对一，纯粹的表间 join 开销。
- **归因即路由**（课程原话）落法：`user_input` → 改题不改产品；`model_capability` → 进模型能力矩阵；`scenario_fit` → 进需求池；`system_config` → 进反馈池。见 D5。
- **归因三原则**（只下初步判断 / 留证据 / 可复现）落法：yaml 上的 `attribution` 是**默认值**，是「初步判断」；人工评审可以逐题覆盖并留证据，覆盖值优先，见 D4。

### D3 · 风险定级 P0~P3 = 频率 × 影响，合规一票 P0

课程第 22 节 4.1 的四级定义：**P0 阻断性**（合规事故风险**或核心功能失效**，立即处理、暂停上线）· **P1 严重**（高频场景的显著质量问题，本迭代必修）· **P2 一般**（影响体验但不阻断，排期修）· **P3 轻微**（边缘场景或轻微瑕疵，有空修/记录观察）。

4.2 的公式是一张 **3×3 矩阵，不是连续分数**，而且**矩阵里没有 P0**：

|  | 影响大（核心场景/用户实际损失） | 影响中（体验明显受损） | 影响小（轻微瑕疵） |
|---|---|---|---|
| **频率高**（高频场景/多题复现） | P1 | P2 | P3 |
| **频率中** | P1~P2 | P2 | P3 |
| **频率低**（长尾场景/单题偶发） | P2 | P2~P3 | P3 |

频率判据（原文）：问题出现在什么场景（核心 or 长尾）· 复现比例（同类题里几题出问题）· 是否稳定复现（每次都错 or 偶发）。
影响判据（原文）：用户后果（实际损失 / 体验受损 / 无感）· 业务后果（口径事故 / 投诉风险 / 无）。

**Neo 侧的三档落法**（三条判据各有现成数据，不引入新采集）：

| 档 | 频率 | 影响 |
|---|---|---|
| 高 / 大 | 题在 `held-in` 或 `safety` split（核心场景）**且** 同 `category` 题里复现 ≥ 1/3 **且** pass^k 里 k 次全挂（稳定复现） | split 为 `safety` 或 `held-out`，**或** `dispositions` 含 `needs_human` |
| 中 | 复现但非 k 次全挂 | split 为 `held-in` |
| 低 / 小 | `control` split 或单题偶发 | `control` split，**或** `dispositions` 含 `not_in_denominator` |

🔴 **影响这一列是代理指标，不是真影响**。课程的影响判据是「用户后果 / 业务后果」，而评测不是线上，Neo 拿不到任何用户后果数据。split 权重只是「这题有多重要」的近似。报告里必须把自动算出的级别标成**建议值**，人工改级优先——这正是下面这条操作规则的机制落点。

**4.3 四条操作规则在 Neo 的落法**：

1. **合规一票 P0，不进矩阵直接锁定**。Neo 的两个命中条件：该题所在 split 为 `safety`（`SplitBucket @ src/host/testing/ci/sampleSplits.ts:34`），或断言 `no_forbidden_tool_call` 失败（类型 `types.ts:860`，实现 `assertionEngine.ts:1074`，语义见 `expectationCatalog.ts:27`「没有发出题目禁止的工具调用、命令或工具输入」）。另按 P0 定义的后半句「核心功能失效」，`crash` 与整轮 failRun 也直接 P0。
2. **矩阵是参考，业务可上调，上调要有理由记录**。落点就是 D4 三件套里的 `severity` 字段（人工可改）+ `evidence` 字段（理由）。这条规则本身就是三件套必须存**结构化定级**而不是只存自动算值的理由。
3. **定级要在问题清单里写明依据**（原文示例：「P1：核心退款场景，3/8 题复现，口径错误」）。Neo 侧 = 报告里每个 code 的定级旁边打印它的三条频率判据实测值（split / 复现比例 / pass^k 结果），不是只打印一个 P 几。
4. **定级可随信息更新调整，变更留记录**。`annotations` 是 append-only 表，靠 `supersedes_id`（`schemaAnnotations.ts:16`）做修订——改级天然留痕，不需要额外机制。

### D4 · 归因三件套进 `annotations` 表，加一列 `attribution_json`

抽屉人工评审段 `EvalCaseAnnotation.tsx` 现有：👍/👎（`overall`）+ 失败笔记（`note`）+ 五维（`dims`）+ 「进金标集」（`gold`）。三件套（初步归因 / 证据 / 建议）+ 定级加在同一段。

**决策：加一列，不复用现有列。**

参照先例：#1823 的 `gold` 是**复用**了现成列——`calibration_split TEXT`（`schemaAnnotations.ts:15`），写入在 `evaluation.ipc.ts:183`（`calibration_split: request.gold ? 'gold' : null`），读回在 `:361`。那次复用成立，是因为语义恰好同构：两者都是「这条标注属于哪个集合」。

三件套没有同构的现成列：

- 塞 `note TEXT`：结构化字段退化成自由文本，定级就没法统计，D3 的公式落空。
- 塞 `dims_json`：那一列有闭集类型断言守着（`dimensions.ts:11-16` 的 `MissingAiReviewDimension` / `UnknownAiReviewDimension` 两个 never 断言），IPC 侧 `validateAnnotationRequest @ evaluation.ipc.ts:295` 对每个 key 跑 `isAiReviewDimension` 拒收未知维。往里塞非维度键等于拆掉那道断言——这正是 `feedback_relaxing_a_gate_orphans_its_freeloaders` 记的形状。

所以：`safeAlter(db, 'ALTER TABLE annotations ADD COLUMN attribution_json TEXT', logger)`（`safeAlter @ src/host/services/core/database/schemaHelpers.ts:18`，用法见 `schema.ts:44-49`，幂等）。

**一列 JSON 而不是四列**：字段会随本 ADR 演进（定级公式可能改、证据可能加字段），一列避免反复 ALTER；`annotations` 是 append-only 表（靠 `supersedes_id` 做修订，`schemaAnnotations.ts:16`），历史行天然保留旧 schema 的快照。

列内结构：

```json
{ "attribution": "scenario_fit", "evidence": "第 3 步直接写文件，没先问", "suggestion": "在 write 前加确认", "severity": "P1" }
```

IPC 校验加在 `validateAnnotationRequest`（归因枚举外拒收、`severity` 只认 P0~P3），与 `:312` 的 `gold must be a boolean` 同一段。

### D5 · 「待回归」= 回流草稿硬化后进回归集，接在现有闸后面，不新建状态机

课程第 22 节第五部分的生命周期表（🔴 原文正文说「走六个状态」，但表里列了 **7 行**——第 7 行「已驳回」是旁支出口，不在主线六步上，这个出入是原文自身的，本 ADR 照抄不修）：

| 课程状态 | 含义（原文） | 责任方 | Neo 对应 |
|---|---|---|---|
| 发现 | 测评中识别，刚进清单 | 测评岗 | 一轮真跑里该题 `failed` + 抽屉人工评审留下三件套 |
| 待确认 | 等开发确认问题存在（可复现） | 开发 | 🔴 **Neo 没有**。测评岗与开发是同一个人，没有跨角色确认环节。最近似物是 pass^k 复现验证，但那是机器做的不是开发确认 |
| 已确认 | 确认为真实问题，定级完成 | 测评岗 | = 三件套里填了 `severity`（D4） |
| 修复中 | 已分派，开发处理 | 开发 | fleet 台账里该单 `claim` 后在跑，或反馈池 `fb triage` 已立单关联 |
| **待回归** | 修复完成，等测评验证 | 测评岗 | = **过了回流闸、没过硬化闸的草稿**（见下） |
| 已关闭 | 回归验证通过 | 测评岗 | = 草稿过硬化闸进回归集（`isCaseHardened` 返回 `{hardened:true}`） |
| 已驳回 | 确认不成立（不能复现 / 判定有误） | — | 🔴 **Neo 没有显式出口**。最近似的是 `dispositions` 的 `known_issue`（认了但不修）与 `not_in_denominator`（不进分母），但两者都不表达「判定有误」。原文要求驳回附复现尝试记录或指出原判定哪里错——Neo 目前无处写 |

原文三条关键纪律里，有两条 Neo 已有机制，一条没有：

- **「待回归」是 AI 测评特有的关键状态，跳过回归直接关闭 = 埋雷** → Neo 的硬化闸就是这道强制回归。
- **关闭权在测评岗，开发说「修好了」不算关闭** → `isCaseHardened` 的第三条拒因 `review_pending`（`caseHardening.ts:15`）正是这条纪律的机制体现：没人复核过的草稿进不了回归集。
- **驳回要有依据** → 🔴 Neo 无落点，见上表。

**回流闭环**（原文：已关闭的问题，其题目转化进回归集，关闭不是终点而是永久测试题的起点）——这与 Neo 的 HARVEST 链路是同一件事，Neo 早已实现，不需要新做。

### Neo 现有的两段闸

Neo 已有的回流链路是两段闸，不是四道独立闸：

1. **回流闸**（能不能建草稿）：`checkPostLaunchReflowGates @ src/host/testing/postlaunch/postLaunchReflowGate.ts:32`，三个拒绝理由 `not_candidate` / `consent_required` / `consent_stale`（`:23`）。同意档至少 `turn_excerpt`（`:43`），`metadata` 只能留分数行。
2. **硬化闸**（草稿能不能进回归集）：`isCaseHardened @ src/host/testing/caseHardening.ts:9`，三个拒绝理由 `answer_side_missing`（`:13`）/ `no_expectations`（`:14`）/ `review_pending`（`:15`）。

「待回归」不是新状态，它就是**过了闸 1、没过闸 2 的草稿**——`isCaseHardened` 返回 `{hardened:false}` 且 reason 是 `review_pending` 或 `no_expectations` 的那些。定级 P0/P1 的归因结论挂在这些草稿上，`EvalCaseListTab.tsx` 现有的硬化筛选加一个「待回归」视图即可，零新表、零新枚举。

三件套随草稿带走：`deriveHarvestSeed @ packages/internal/evaluation-center/src/host/evaluation/harvestCandidates.ts:180` 建草稿时已带 `sessionId` + `tags` + `description`（`:189` 拼 `${sessionTitle}（会话里的工具调用：${trace}）`）。把最新一条人工评审的三件套追加进 `description`，不动 case 契约。

**真缺陷进反馈池**（不是直接开需求单，纪律见 `feedback_defects_go_to_feedback_pool_first`）：归因为 `scenario_fit` 或 `system_config` 且定级 P0/P1 的，证据拷进 `~/.ship/feedback-inbox/<日期-主题>/`，再 `~/Downloads/ai/fleet-console/cli/fb add`（账本 `~/.ship/feedback.jsonl`）。抽屉里是否做成一键，见待拍板 Q4。

## 不做什么

- **不接 5/6 两套轨迹语言**。`DeviationMarker.type` 与 `FailureCategory` 的接电是独立一单（要改 `testRunner.ts:1080` 那段并给 `enableTrajectoryAnalysis` 定默认值），本单只在归因轴里给它们留一条将来的映射路（`FailureCategory` 的 7 码可整体映到四类归因），不在本单开工。
- **不动 `failureStage` 的自由 string**。收紧成枚举会牵动 28 处引用和 web 侧透传，与本单无关。
- **不新建「问题清单」页**。课程的问题清单在 Neo 里就是回流草稿列表 + 反馈池，两个都已存在。
- **不补生命周期缺的两个状态**。「待确认」的前提是测评岗与开发分属两人，Neo 不成立，补出来只会是一个永远自己点给自己的按钮；「已驳回」值得补（原文要求附复现尝试记录或指出原判定错在哪），但它要改的是 `caseHardening` 的出口而不是三件套，与本单范围无关，留给后续单。

## 风险

- **定级矩阵的三档切分是拍脑袋的**（复现 ≥ 1/3、pass^k 全挂、split 归档）。矩阵本身来自课程原文，但把「频率高/中/低」「影响大/中/小」翻译成 Neo 可判的阈值这一步是我定的，第一轮真跑后按实际分布回调；修订记录段留着接这次回调。
- **D1 的两个新 failcode 靠判官维度触发**，而判官刚在 #1821 加了 `abstain` 三值——判官弃权时这两码既不命中也不排除，会静默落回 `wrong_output`。刀 2 要把这个交互写进测试。
- **归因默认值会被当成结论**。yaml 上的 `attribution` 是统计先验，不是这一题的判断；报告里必须标「默认归因」与「人工归因」的区别，否则就是 `feedback_verify_seat_model_from_run_record` 记的那个形状——推断落进文档后与取证字面无法区分。

## 待爸拍板

| # | 问题 | 类型（拍错了受伤的是什么） | 我的建议 |
|---|------|------------------------|---------|
| Q2 | 新 failcode `scenario_mismatch` / `intent_drift` 的 `match` 要不要**支持判官维度**？现有 `match` 只认四个文本字段（`failureCodes.ts:113`），支持维度等于给码本加一条新的输入通道 | **架构**——拍错了码本从「正则匹配器」变成「判官消费者」，回头拆不掉 | 开，但限定只认 `AI_REVIEW_DIMENSIONS` 五维且判官非 abstain。不开的话这两类就只能靠人工评审，落不进 `failureDistribution`，D3 的频率算不出来 |
| Q3 | 定级 P0~P3 是**每题一个**还是**每 failcode 一个**？公式里频率是 code 级的，影响是题级的 | **判据**——拍错了报告里的 P0 数会差一个数量级，且两种口径的数字长得一模一样 | code 级出「本轮该 code 的风险等级」进报告；题级只在人工评审里由人给，两者分开显示不混算 |
| Q4 | 抽屉里的「进反馈池」做**一键**还是只给**可复制的 `fb add` 命令文本**？一键意味着 renderer 要能起外部进程 | **权限边界**——拍错了给评测抽屉开了一条执行外部命令的路，这条路开了就关不回去 | 只给命令文本。一键收益是省一次粘贴，代价是一条新的执行通道，不划算 |
| Q5 | 归因的**默认值**要不要真写进 yaml？写了每题都有初步归因（省事），但也意味着大部分题的归因是先验而非判断 | **判据**——拍错了归因统计变成 yaml 作者的意见分布，不是真实分布，而且报表上看不出来 | 写，但报告与导出必须分列「默认归因」「人工归因」两栏，且默认归因不进任何聚合口径 |
| Q6 | 刀 2 的范围：只做抽屉三件套 + IPC + 草稿带走，还是**连 D1 的三个新 failcode 一起**？ | **范围**——拍错了刀 2 从一个可验收的小单变成跨 yaml/判官/报告三处的中单 | 刀 2 只做三件套（D2 的 yaml 字段 + D4 + D5 的 description 拼接）。D1 的三个新码与 Q2 的新 match 通道单开一刀 3 |

## 拍板记录

> 只增不改。每条一行：日期 · 问题号 · 决定 · 决定人。

| 日期 | 问题 | 决定 | 决定人 |
|------|------|------|--------|
| 2026-09-15 | Q2 | 开，但 `match` 只认 `AI_REVIEW_DIMENSIONS` 五维且判官非 abstain；随三个新 failcode 归刀 3，不在刀 2 | 爸 |
| 2026-09-15 | Q3 | code 级自动定级进报告（「本轮该 code 的风险等级」）；题级定级只在人工评审三件套里由人给；两者分开显示不混算 | 爸 |
| 2026-09-15 | Q4 | 做一键，但钩子命令可配置（设置项 `feedbackHookCommand`，默认空）：有配置 = 证据写进指定目录 + 执行命令 + toast 回显；无配置 = 按钮退化为「复制 fb add 命令」。理由：真顾虑不是执行通道（host 本就起子进程），是产品代码写死爸机器上的私有工具路径 | 爸 |
| 2026-09-15 | Q5 | 归因默认值写进 yaml `attribution:`；报告与导出分列「默认归因 / 人工归因」两栏，默认归因不进任何聚合口径 | 爸 |
| 2026-09-15 | Q6 | 刀 2 只做三件套（D2 yaml 字段 + D4 抽屉/IPC/表 + D5 草稿 description 拼接 + Q4 一键钩子）；三个新 failcode 与 Q2 的判官维度 match 单开刀 3 | 爸 |

## 修订记录

| 日期 | 改动 | 原因 |
|------|------|------|
| 2026-09-15 | 初稿（刀 1） | N-EVAL-ATTRIBUTION-CODEBOOK |
| 2026-09-15 | 拍板记录五条落表；Q4 建议由「只给文本」改为「可配置钩子一键」 | 爸 09-15 早对齐点头，刀 2 派 opus |
| 2026-09-15 | D1 六类名称 / D3 公式 / D5 生命周期按课程第 09/22 节原文对齐；待拍板表删去 Q1（已由原文解决） | 劳拉提供原文切片 |
