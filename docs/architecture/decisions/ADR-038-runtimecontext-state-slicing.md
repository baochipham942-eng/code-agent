# ADR-038: RuntimeContext 拆袋 — 共享可变袋分批收敛为切片状态

- **状态**: Accepted（产品负责人 2026-07-13 拍板；施工另立项）
- **日期**: 2026-07-13
- **来源**: 2026-07-13 架构擂台两选手共识 P0（审计报告见私档 audits/2026-07-13-arena-arch-findings.md）
- **证据基线**: 字段×模块读写矩阵（私档 research/2026-07-13-runtimecontext-field-matrix.md，基线 commit `ac5957ed9`，Codex dry-run 盘点 + 监工盲区补扫/抽验）

## 问题

`src/host/agent/runtime/runtimeContext.ts` 的 `RuntimeContext` 是 141 个顶层字段的共享可变袋（注释自认 "Mutable shared state. Single object, all modules share the same reference"），被 45 个文件消费。任意 runtime 模块可读写任意字段，改 A 伤 B；已兑现的最小病例是 `planModeActive` 双字段分叉（擂台 M2，cb238363f 已删）。

矩阵盘点结论（141 字段）：

| 分类 | 数量 | 含义 |
|---|---|---|
| init-only | 51 | 只在 `agentLoop.ts` 构造点写入，之后纯读 → 天然只读配置 |
| single-module | 28 | 运行期读写集中在单一模块 → 不该进共享袋 |
| cross-module | 48 | ≥2 模块读+写 → 真正的共享状态，拆分高危区 |
| dead | 14 | write-only 或完全无人用 → 直接删 |

即：**袋里只有约 1/3 字段是真共享状态**，其余 2/3 要么该锁死、要么该搬走、要么该删掉。

## 决策

不做大爆炸重写（45 个消费文件）。分四批渐进收敛，每批独立可合、独立回归，机制优先于声明：

- **编译期锁**：init-only 字段加 TypeScript `readonly`，违规写方直接编译失败——零运行时变化，typecheck 即验证器。
- **所有权下沉**：single-module 字段迁出袋子，成为 owner 模块的私有状态。
- **域切片**：cross-module 字段按域聚合为带显式变更方法的小状态类，写操作走方法不走裸赋值。

### 批 0 — dead 字段清理（复刻 M2 流程）

删除 14 个 dead 字段：`contentVerifier`、`userHooks`、`currentAgentMode`、`interactionMode`、`totalIterations`、`researchModeInjected`、`currentRequestShapeHash`、`_truncationRetried`、`contentVerificationRetries`、`contextHealthy`、`autoCompressThreshold`、`contextBudgetRatio`、`genNum`、`initialSystemPromptLength`。

- 复验已做三层：矩阵 grep（src/host+src/shared）+ 监工补扫盲区（src/cli/src/web/src/renderer 无 RuntimeContext 命中）+ 无 `...ctx` 整体展开/序列化用法（write-only 判定不会被 spread 打穿）。施工时每字段仍按 M2 流程独立 grep 一遍（含 tests/）再删。
- 注意 `contextHealthy` 等 5 个是整个 "Context health" 注释段的死块——初始化写了从未消费，属历史遗留半成品，删除即可（真 context health 信号走 `pipelineAutocompactNeeded`/`droppedPromptBlocks`，均为活字段）。
- **回归面**：typecheck + 引用测试同 commit 迁移 + 全量 vitest 基线对照（失败集⊆纯 main 基线集判定法）。
- 体量：纯删除，预计 1 个 PR。141 → 127 字段。

### 批 1 — RunConfig 只读化（51 字段加 readonly）

51 个 init-only 字段就地加 `readonly` 修饰符，**不搬家不嵌套**（嵌套要改 45 个文件的访问路径，readonly 就地已达成"锁死误写"的全部安全收益）。涵盖：身份/配置（sessionId、runId、workingDirectory、maxIterations…）、服务引用（circuitBreaker、goalTracker、planningService、compressionPipeline…）、开关与上限（enableHooks、maxToolCallRetries、scaffoldProfile、autoApprovePlan…）。

- **明确不进此批**（矩阵证实有运行期写方，加 readonly 会假红）：`modelConfig`（inference provider fallback + messageProcessor 运行期切模型）、`hookManager`（conversationRuntime 惰性初始化）、`messages`（会话本体，见批 3 残留说明）。
- `checkpointRootDir` 只有测试写入（低置信项已复验），随此批加 readonly；测试通过构造参数注入不受影响。
- 服务引用 readonly 锁的是引用本身，服务内部状态自治不受影响。
- **回归面**：typecheck 就是验证器——若编译器揪出隐藏写方，说明矩阵漏报，个案升级处理（要么是 bug 要么改归类），不许静默去掉 readonly。加跑全量 vitest 兜底。零运行时变化。
- 体量：机械修饰符 + 可能的个案，1 个 PR。批 0+批 1 可同一施工会话完成。

### 批 2 — 所有权下沉（28 个 single-module 字段迁出袋子）

按 owner 模块分组，每组一个独立 PR，字段从 RuntimeContext 删除、变为 owner 模块自持状态：

| 组 | 字段（代表） | owner |
|---|---|---|
| 2a stagnation/防呆族 | recentToolFingerprints、recentToolNames、stagnationWarningEmitted、searchSpamWarningEmitted、antiScrapingHitsInRun、stopHookRetryCount、userStopHookBlockCount、toolCallRetryCount、deliveryCriticBlockCount、_consecutiveTruncations | messageProcessor |
| 2b inference 恢复族 | _contextOverflowRetried、_artifactNonStreamingRetried、_artifactRepairCompactWriteRetried、_networkRetried、currentModelDecision | contextAssembly/inference |
| 2c compression 恢复族 | _consecutiveCompacts、_autoCompactPaused、_summaryFailureStreak、_summaryCooldownUntil | contextAssembly/compression |
| 2d 会话流程族 | isPaused、interruptMessage、isPlanModeActive、userHooksInitialized、structuredOutput、structuredOutputRetryCount、budgetWarningEmitted、goalEvidenceGateBounces、turnQualityMemory | conversationRuntime / 各 gate |

- **关键约束：每轮 reset 语义必须保留。** 这些字段多数由 `conversationRuntime#initializeRun` 每轮重置。迁移后 owner 模块暴露显式 `resetForRun()/resetForTurn()`，由 conversationRuntime 在原重置点调用——重置责任可见化，而不是散在袋子里被顺手清。
- 迁移形态从简：owner 是类的收进私有字段；owner 是函数模块的收进模块级 state 对象（跟随 AgentLoop 实例生命周期，经构造注入，禁止真·模块级单例——eval 已走 per-worker agent 并行，进程级共享会串台）。
- **回归面**：每组 PR 跑 owner 模块 targeted 套件（tests/unit/agent/ 对应族）+ 全量 vitest 基线对照。行为零变化，纯搬家。
- 体量：4 个小 PR。127 → 99 字段。

### 批 3 — 域切片（48 个 cross-module 字段按域聚合）

真共享状态按域收敛为嵌套切片，**每切片一个小状态类：字段私有 + 读 getter + 显式变更方法**（如 `control.cancel(reason)`、`turn.beginTurn(id)`），裸赋值从此绝迹——"谁在写"从 grep 考古变成方法调用链。仓内已有先例：contextAssembly 子模块的 `ctx.runtime.*` 包装即嵌套访问模式。按风险升序分 5 个 PR：

| 序 | 切片 | 字段（代表） | 主要跨界方 | 风险 |
|---|---|---|---|---|
| 3a | TurnState | currentTurnId、turnStartTime、toolsUsedInTurn、lastStreamedContent、needsReinference、isSimpleTaskMode、messageDeltaSeq、currentIterationSpanId、thinkingStepCount、effortLevel、thinkingEnabled、_researchModeActive、_researchIterationCount、activeSkillInvocation、activeSkillContextBlock、skillToolBoundary、skillModelOverride | streamHandler / messageProcessor / toolExecutionEngine / turnQuality | 中 |
| 3b | ControlState | isCancelled、isInterrupted、abortController、runAbortController、savedMessages、forceFinalResponseReason、forceFinalResponsePrompt、preApprovedTools、externalDataCallCount | conversationRuntime / inference / 各 gate | 中（取消/中断路径回归必须真 dogfood） |
| 3c | ContextHealth | compressionState、pipelineAutocompactNeeded、persistentSystemContext、droppedPromptBlocks、currentSystemPromptHash、checkpointRebuildLastWatermarkId、_networkRetryCount | contextAssembly 族 / checkpoint runtimeBoundary / runtimeStatePersistence | 中（有持久化序列化面：runtimeStatePersistence 读 compressionState） |
| 3d | RunStats+Tracing | traceId、lastModelTraceSpanId、runStartTime、totalInputTokens、totalOutputTokens、totalTokensUsed、totalToolCallCount、turnStartTime、pendingRuntimeDiagnostics、turnModelDecision | streamHandler / runFinalizer / completionSummaryService（跨出 runtime 目录） | 低-中 |
| 3e | ArtifactState | artifactRepairGuard（9 写方 14 读方，全袋最大热区）、artifactValidationPassedTargetFile、declaredDeliverables | artifact repair 全家桶 + gates | **高，建议单独立项**（可能与 repair 状态机重构合并做） |

- **明确留袋（残余核心）**：`messages`（会话本体，归会话写路径收敛线管）、`modelConfig`（运行期 provider fallback 写方，将来归 ModelRouting 域）、`hookManager`、`onEvent`、`toolExecutor` 等骨架引用。拆完后 RuntimeContext 退化为 ~15 字段的组合根，注释从 "Mutable shared state" 改为真实契约。
- **回归面**：每切片 PR = 涉及模块 targeted 套件 + 全量 vitest 基线对照；3b 加取消/中断真机 dogfood（web + 桌面各一次）；3c 加 checkpoint/恢复链路测试（tests/unit/context/checkpoint*）；3e 加 artifact repair 全家桶套件 + 游戏族假红单跑判定。

## 迁移顺序总览与门槛

```
批0 dead 删除        ─┐ 可同会话
批1 readonly 锁死    ─┘ （机械，编译器验证）
批2 所有权下沉        4 个小 PR（2a→2d，无相互依赖可并行）
批3 域切片           3a→3b→3c→3d 顺序做；3e 单独立项
```

- 每批合并门：typecheck 绿 + 全量 vitest 失败集⊆纯 main 基线集 + 该批声明的专项回归面。
- 批间无回滚耦合：任何一批出问题可独立 revert，不牵连已合批次。
- 施工分工建议：批 0/1/2 机械性强，适合派 Codex 按工单施工 + 监工终验；批 3 涉及语义判断，Claude 主刀。

## 已否决的替代方案

1. **大爆炸重写**（一次拆成独立传参的 5 个对象）：45 个消费文件签名全改，单 PR 回归面不可控。否决。
2. **只加注释/文档声明字段归属**：擂台原则——护栏是声明不是机制（H1 同款病）。否决。
3. **全部字段嵌套分组但不改可变性**：改了 45 个文件的访问路径却没锁死任何写方，纯 churn。否决——嵌套只用在批 3 需要"写走方法"的真共享域，readonly 就地解决的（批 1）不嵌套。

## 后续

- 本 ADR 只定方向与批次契约；每批施工独立立项，工单引用本 ADR + 矩阵。
- 矩阵会漂移：每批开工前重跑一次该批字段的 grep 核验（矩阵基线 `ac5957ed9`，落后即补扫）。
- 新增 RuntimeContext 字段的准入规则自本 ADR 起生效：新字段必须声明归属切片（config/turn/control/contextHealth/stats/artifact），进不了任何切片的要在 PR 里说明为什么。
