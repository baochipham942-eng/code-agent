# Always-on Session Model Benchmark: Memoh

日期：2026-05-14
范围：code-agent `main` 本地工作区；Memoh 复用 `/tmp/memoh-study`，HEAD `1638a3e`
边界：只研究产品和实现关系，不改代码；scheduler 只作为运行基础设施讨论，不扩成大型 workflow 平台。

## 判断

code-agent 应该新增 session type，但先做成一层很薄的“工作单元身份”。它的价值是把 chat、定时运行、HEARTBEAT.md 自驱动运行、后台任务、subagent 子运行、review 回看挂到同一个可打开、可回看、可继续或重试的身份上。

不要一开始把 session 升级成完整流程引擎。当前系统已经有 Cron Center、DAG Scheduler、Eval Center、Background Task 和 Replay，各自承担控制面或分析面。更好的做法是让这些面共享同一个 `sessionId + session.type + origin`，让用户在 Sidebar 里看到“这是一段什么工作”，在 Timeline/Eval 里看到“它怎么跑的”，在 Automation 里看到“它从哪个规则触发”。

推荐路线是第二套方案：统一 session 类型。轻量过滤只能缓解 UI 混乱，完整 always-on workspace 太大，容易把 scheduler 拉进不必要的平台化。

## code-agent 当前模型

### 1. Session 仍是聊天会话

`Session` 合同只有运行状态，没有类型字段。`SessionStatus` 描述 `idle/running/paused/completed/error/archived` 等状态，`Session` 本体保存 title、modelConfig、workingDirectory、createdAt、updatedAt、workspace、status、workbenchSnapshot、streamSnapshot、归档和 PR/Git 信息。这里没有 `type`、`origin`、`parentSessionId`、`sourceJobId` 或 `readOnly` 语义。
证据：`src/shared/contract/session.ts:11-21`、`src/shared/contract/session.ts:65-87`

数据库的 `sessions` 表同样以聊天持久化为中心：id、title、model、working_directory、created_at、updated_at、workbench_provenance、is_deleted、synced_at。消息表通过 `session_id` 归属到 session。
证据：`src/main/services/core/database/schema.ts:29-60`

`SessionManager.createSession` 生成 `session_${timestamp}_${uuid}`，写入数据库，再初始化 message/todo/workbenchSnapshot 缓存。它没有接收或保存 session type。
证据：`src/main/services/infra/sessionManager.ts:202-244`

`localCache` 也是消息缓存，不是产品 session 模型。`CachedSession` 只有 sessionId、messages、startedAt、lastActivityAt、totalTokens、metadata。
证据：`src/main/session/localCache.ts:60-73`

### 2. Trace 已经把 sessionId 当成回看主键

`TraceProjection` 是 `sessionId + turns + activeTurnIndex`，节点类型覆盖 user、assistant_text、tool_call、system、swarm_launch_request、turn_timeline，但没有 session type。
证据：`src/shared/contract/trace.ts:5-11`、`src/shared/contract/trace.ts:56-60`

Review Queue 的身份更明确：`UnifiedTraceIdentity` 只有 `session_replay` 来源，`traceId` 固定是 `session:${sessionId}`，`replayKey` 等于 sessionId。也就是说 Eval/Review 这条线已经把 sessionId 当成统一 replay key，只是 session 自己还不知道“这段 replay 属于什么类型的工作”。
证据：`src/shared/contract/reviewQueue.ts:7-16`、`src/shared/contract/reviewQueue.ts:103-138`

### 3. Cron 有运行记录，但没有稳定反指到生成的 session

Cron 合同把定义和执行拆开：`CronJobDefinition` 保存 schedule/action/enabled/retry/metadata/nextRunAt，`CronJobExecution` 保存 jobId/status/scheduledAt/startedAt/completedAt/result/error/retryAttempt。执行记录没有 `sessionId`。
证据：`src/shared/contract/cron.ts:23-54`、`src/shared/contract/cron.ts:167-190`

`CronService.executeJob` 每次生成 execution，执行 action，再把 execution 存库。agent action 会创建一个标题为 `[Cron] ${definition.name}` 的 session，然后用这个 session 跑 orchestrator。执行完成后只返回 `{ agentType, prompt, result }`，没有把 `cronSession.id` 写回 execution。
证据：`src/main/cron/cronService.ts:443-491`、`src/main/cron/cronService.ts:515-562`、`src/main/cron/cronService.ts:584-605`

结果是：自动化跑出来的内容确实可能进入 session 列表，但用户只能看到一个像普通聊天的 `[Cron]` 标题；Cron Center 里能看 execution history，却无法一键打开这次运行对应的 session。

`docs/plans/clawdbot-learnings/05-heartbeats-cron.md` 要按历史方案读。它写的是当时“当前 Code Agent 没有定时任务能力”，并参考 Clawdbot 提出 Heartbeat、Cron Jobs、Isolated Agent、`sessionTarget`、`wakeMode` 等模型。现在代码里已经有 CronService 和 HEARTBEAT.md loader，所以这份文档能提供产品语义参考，不能当作当前实现事实。
证据：`docs/plans/clawdbot-learnings/05-heartbeats-cron.md:1-10`、`docs/plans/clawdbot-learnings/05-heartbeats-cron.md:28-45`、`docs/plans/clawdbot-learnings/05-heartbeats-cron.md:74-77`

### 4. code-agent 有两种 heartbeat，语义分裂

`HeartbeatService` 是健康检查服务。它管理 interval、shell/http/tool check、期望、告警和内存 checkHistory，运行结果用于状态和通知。它不创建 session，也不进入 Sidebar。
证据：`src/main/cron/heartbeatService.ts:58-131`

`HeartbeatTaskLoader` 是另一条线：从 `.code-agent/HEARTBEAT.md` 解析 `cron/prompt/channel/active_hours/enabled`，注册成 CronService 的 agent job，并在 action context 里写 `heartbeatTask: true`。这条线会通过 CronService 创建 `[Cron] [Heartbeat] ...` session，但仍然不是 typed heartbeat session。
证据：`src/main/cron/heartbeatTaskLoader.ts:24-31`、`src/main/cron/heartbeatTaskLoader.ts:55-104`、`src/main/cron/heartbeatTaskLoader.ts:164-228`

产品上这会让“心跳”有两套入口：一套像监控，一套像定时 agent。它们都合理，但需要在模型层分清：health heartbeat 是监控对象，agent heartbeat 是常在线工作单元。

### 5. Scheduler/DAG 是执行基础设施

`DAGScheduler.execute` 接受 TaskDAG 和 context，管理 ready tasks、并发、pause/resume/cancel、成功失败状态。它适合承载一次复杂执行，但本身没有 session 持久化、session list、review queue 或 automation linkage。
证据：`src/main/scheduler/DAGScheduler.ts:220-337`

因此 scheduler 不该被提升成用户看见的大型工作流平台。它可以继续服务 DAG Panel、agent task 和内部编排；如果某个 DAG 运行需要回看，应该给这次运行一个 session identity，而不是让 scheduler 自己变成 session 系统。

### 6. Sidebar、Eval Center、Automation 各自成面

Sidebar 读取 sessionStore、backgroundTasks、sessionRuntimes、status presentation，再按状态、workspace、搜索组织列表。它能显示 running/background/status，但没有 session type 过滤。
证据：`src/renderer/components/Sidebar.tsx:134-198`、`src/renderer/components/Sidebar.tsx:581-709`

Cron Center 是自动化控制面。Job Detail 能编辑、启停、删除、手动触发，并展示执行历史；执行历史没有连接到 session replay。
证据：`src/renderer/components/features/cron/CronJobDetail.tsx:18-84`、`src/renderer/components/features/cron/CronJobDetail.tsx:86-188`

Eval Center 的 TurnTimeline 接受 `TelemetryTurn[]` 和 `sessionId`，展示 USER/TOOLS/ASSISTANT/Token，但组件内部并不消费 session type。它适合做“这段 session 的执行轨迹”，不适合承载自动化定义管理。
证据：`src/renderer/components/features/evalCenter/TurnTimeline.tsx:11-18`、`src/renderer/components/features/evalCenter/TurnTimeline.tsx:63-199`

Background Task 是已有 session 的运行态覆盖层。`BackgroundTaskManager` 只是在 running session 上记录 foreground/background、progress、completed/failed，完成后会通知和移除。它更像状态，不应变成 session type。
证据：`src/main/session/backgroundTaskManager.ts:13-20`、`src/main/session/backgroundTaskManager.ts:35-68`、`src/main/session/backgroundTaskManager.ts:71-120`

## 当前边界和缺口

| 模块 | 现在承担什么 | 缺口 |
| --- | --- | --- |
| Session | 聊天消息、workbench 快照、运行状态、归档 | 缺 type、origin、父子关系、自动化来源、只读/生成态 |
| Trace/Replay | 以 sessionId 回看 turn/tool/subagent 信号 | 无法表达这段 trace 来自 chat、schedule、heartbeat 或 subagent |
| Cron | 定义、调度、执行历史 | agent execution 不保存 sessionId，运行详情和可回看的 session 脱节 |
| HEARTBEAT.md | 把自然语言心跳注册为 cron agent job | UI 上像普通 Cron，不像 heartbeat 工作单元 |
| HeartbeatService | 健康检查和告警 | 和 agent heartbeat 同名不同物，缺产品区分 |
| Scheduler/DAG | 内部执行和并发控制 | 不是可打开的用户工作单元 |
| Background | 把 running session 放到后台 | 是状态，不是类型；完成后短暂存在 |
| Review Queue | 把 session replay 纳入人工/交付/失败回看 | review 是分析队列，不是原始工作类型 |
| Sidebar | 会话入口和状态入口 | 无 type 分组，自动化运行混在聊天里 |
| Automation/Cron Center | 规则和执行历史管理 | 缺“打开本次运行 session / 重试本次运行” |

核心问题不是“没有 sessionId”。恰好相反，sessionId 已经是 replay/review 的主键。真正缺的是“sessionId 代表什么工作单元，以及从哪个触发源来”。

## Memoh 的模型

### 1. Session type 是一等字段

Memoh 的 `Session` 包含 BotID、RouteID、ChannelType、Type、Title、Metadata、ParentSessionID。内置类型是 `chat`、`heartbeat`、`schedule`、`subagent`、`discuss`。空 type 默认变成 `chat`。
证据：`/tmp/memoh-study/internal/session/service.go:18-40`、`/tmp/memoh-study/internal/session/service.go:70-118`

数据库也把类型写死进 `bot_sessions.type`，并限制在这五类；`parent_session_id` 允许子 session 关联父 session。消息、审批等记录再通过 session_id 挂到 session。
证据：`/tmp/memoh-study/db/postgres/migrations/0001_init.up.sql:340-358`、`/tmp/memoh-study/db/postgres/migrations/0001_init.up.sql:384-417`

`CreateNewSession` 可以按 route 新建并设为 active session，`EnsureActiveSession` 则复用 route 当前 active session。这里区分了“聊天渠道里的活跃会话”和“每次自动运行的新 session”。
证据：`/tmp/memoh-study/internal/session/service.go:253-296`

### 2. Heartbeat 每次运行都创建 heartbeat session 和 log

Heartbeat service 启动时加载 enabled bots，按 interval 注册 cron job。每次 `runHeartbeat` 会先通过 `sessionCreator.CreateSession(ctx, botID, "heartbeat")` 创建新 session，再创建 heartbeat log，并把 sessionID 放进 trigger payload。运行完成后 log 写入 status、result_text、error、usage、model。
证据：`/tmp/memoh-study/internal/heartbeat/service.go:29-57`、`/tmp/memoh-study/internal/heartbeat/service.go:60-82`、`/tmp/memoh-study/internal/heartbeat/service.go:110-173`

Resolver 侧用同一个 SessionID 执行内部 agent，并把 `cfg.SessionType = "heartbeat"`。它读取 `/data/HEARTBEAT.md` 生成 heartbeat prompt，文本以 `HEARTBEAT_OK` 作为 ok 判断。
证据：`/tmp/memoh-study/internal/conversation/flow/resolver_trigger.go:89-164`

Memoh 的关键点在于每次心跳都会落成一段可回看的 typed session，日志和会话互相指向。配置复杂度反而不是重点。

### 3. Schedule 每次运行也创建 schedule session 和 log

Schedule service 管理 cron pattern、command、max calls、enabled/currentCalls。每次 `runSchedule` 会递增 calls，创建 `schedule` session，创建 schedule log，payload 带 command 和 sessionID，resolver 里 `cfg.SessionType = "schedule"`，最终写回 status/result/usage/model。
证据：`/tmp/memoh-study/internal/schedule/service.go:25-63`、`/tmp/memoh-study/internal/schedule/service.go:81-124`、`/tmp/memoh-study/internal/schedule/service.go:250-315`、`/tmp/memoh-study/internal/conversation/flow/resolver_trigger.go:34-87`

这比 code-agent 当前 CronService 多了一个关键闭环：规则、执行 log、生成 session 是同一条链，而不是三块彼此靠标题猜测。

### 4. Sidebar 用 type 过滤，生成型 session 默认只读

Memoh 的 session sidebar 默认 filterType 是 `chat`，过滤项包括 chat、discuss、heartbeat、schedule、subagent。chat tab 里会把 `heartbeat/schedule/subagent` 设为 read-only。
证据：`/tmp/memoh-study/apps/web/src/pages/home/components/chat-sidebar-sessions.vue:32-66`、`/tmp/memoh-study/apps/web/src/pages/home/components/chat-sidebar-sessions.vue:164-215`、`/tmp/memoh-study/apps/web/src/store/chat-list.ts:192-204`

Bot heartbeat 页面负责配置开关、interval、model，并列出 heartbeat logs、状态、结果、错误、usage。Schedule 页面负责创建/编辑/启停定时规则。也就是说 Memoh 没有把所有控制都塞进 Sidebar，Sidebar 只做“打开和回看 session”。
证据：`/tmp/memoh-study/apps/web/src/pages/bots/components/bot-heartbeat.vue:68-139`、`/tmp/memoh-study/apps/web/src/pages/bots/components/bot-heartbeat.vue:173-255`、`/tmp/memoh-study/apps/web/src/pages/bots/components/bot-schedule.vue:1-120`

## 是否新增 session type

应该新增。这个字段要承担真实产品能力，至少统一以下四件事：

1. 打开：自动化、心跳、子任务和聊天都能从 Sidebar 或对应控制面打开。
2. 回看：Timeline/Eval/Replay 不再只知道 sessionId，还知道它来自什么触发源。
3. 继续：chat 可以继续输入；生成型 session 默认只读，但可从它派生 retry 或 follow-up。
4. 重试：Cron/Heartbeat/Schedule 的某次 execution 能关联到原 session，并创建 retry session 或复用定义重跑。

建议的最小类型集：

| Type | 是否首批 | 用户价值 | 备注 |
| --- | --- | --- | --- |
| `chat` | 是 | 用户主动对话、当前默认行为 | 默认值，兼容旧数据 |
| `schedule` | 是 | 每次定时 agent 运行可打开、可回看、可重试 | 对应 Cron agent execution；job definition 留在 Automation |
| `heartbeat` | 是 | HEARTBEAT.md 或未来主动心跳运行可审计 | 与 health heartbeat 区分，首批只覆盖 agent heartbeat |
| `subagent` | 谨慎 | 子 agent 独立运行可查看上下文、输出和父 session | 只有当 subagent 有独立 transcript/progress 时升级，否则保留在父 trace |
| `review` | 暂不做 type | 用户价值在 triage 和评审队列，不是原始执行 | 用 badge/filter 表示“已入 review”更合适 |
| `background` | 不做 type | 后台是运行态，用户关心是否还在跑 | 保持 status/filter |
| `automation` | 不建议作为 run type | 名字太泛，容易和控制面混淆 | 可以作为 origin/source，而不是 session type |

最小字段建议：

| 字段 | 用途 |
| --- | --- |
| `type: 'chat' | 'schedule' | 'heartbeat' | 'subagent'` | Sidebar 过滤、只读策略、Timeline 标识 |
| `origin?: { kind, id, name }` | 指向 cron job、heartbeat task、manual trigger、parent agent |
| `parentSessionId?: string` | subagent/retry/follow-up 的父子关系 |
| `sourceRunId?: string` | 反指 CronJobExecution 或 heartbeat/schedule log |
| `readonly?: boolean` | generated session 默认只读 |
| `retryOfSessionId?: string` | 重试链路 |

这些字段足以把现有面连起来，不需要先重做 scheduler 或 Eval Center。

## Sidebar / Timeline / Eval Center / Automation 重排

### Sidebar

Sidebar 应该是“工作单元入口”，但不承担自动化规则编辑。建议在当前状态过滤之外增加 type 过滤：

- 全部
- Chat
- Running
- Background
- Schedule
- Heartbeat
- Subagent
- Review

这里 `Review` 可以是 saved filter，筛选已进入 Review Queue 的 session，不必是 session type。生成型 session 显示触发源和只读标记，例如 `Schedule · 每日检查`、`Heartbeat · 09:00`。右键菜单保持克制，继续保留 pin/rename/archive/export 这类日常操作；Replay/Review 入口更适合当前 session 顶部菜单和 Eval Center。

### Timeline

Timeline 应该成为“这段工作怎么跑”的统一表达。对 chat 展示 turn/tool；对 schedule/heartbeat 增加触发元信息：

- 触发时间、触发源、job id/run id
- prompt/command/checklist 摘要
- 是否 skipped、failed、retried
- 关联的 CronExecution 或 heartbeat task

这样 Timeline 不需要理解完整 scheduler，只消费 session type 和 origin。

### Eval Center

Eval Center 继续做质量分析和 review queue。它应该接受所有 session type 的 replay，但不要把 review 自己变成 session type。Review Queue 可以记录 reason/source/failure metadata，并给 Sidebar 一个 badge 或筛选条件。

### Automation / Cron Center

Automation 是规则控制面，负责创建、编辑、启停、手动触发和查看执行历史。每条 agent execution 应该有 `sessionId`，UI 上补两个动作：

- 打开本次运行 session
- 用同一规则重试，生成 retry session

这样 Automation 不需要吃掉 Sidebar；Sidebar 也不需要管理 cron definition。

## 三套产品方案

### 方案一：轻量过滤

做法：

- 不改 session schema 或只用 metadata。
- Cron agent session 标题/metadata 标出 `[Schedule]`、`[Heartbeat]`。
- Sidebar 增加基于 metadata/title 的过滤。
- Cron execution 结果里尽量附带 sessionId。

优点：

- 改动小，能快速降低 `[Cron]` session 混在聊天里的噪音。
- 可先验证用户是否真的会从 Sidebar 回看自动运行。

代价：

- metadata/title 推断不稳，历史兼容和迁移会越来越乱。
- Eval/Review/Timeline 仍然不知道 session 的真实类型。
- 重试和父子关系以后还要补一轮。

适用场景：

- 只想先让 Sidebar 看起来不乱，作为过渡可以接受。

### 方案二：统一 session 类型

做法：

- 在 Session contract、DB、repository、sessionStore 增加 `type/origin/parentSessionId/sourceRunId/readonly`。
- 旧 session 默认 `chat`。
- Cron agent action 创建 `schedule` session，并把 `sessionId` 写进 `CronJobExecution`。
- HEARTBEAT.md 创建 `heartbeat` session，和 health heartbeat 保持命名/入口区分。
- Sidebar 增加 type filter 和 generated/read-only 标记。
- Cron Center execution detail 增加“打开运行 session / 重试”。
- Eval Center 读取 type 展示上下文，但 Review Queue 保持现有 session replay 模型。

优点：

- 直接解决当前断点：session、trace、automation、review 共享一套身份。
- 不大动 scheduler，也不改写 Eval Center。
- 为 subagent 子 session、retry chain 留下空间。

代价：

- 需要 schema migration 和 IPC/store 类型贯通。
- 需要认真处理旧数据默认值和标题/搜索行为。
- 需要定义 generated session 的只读/继续策略。

适用场景：

- 最符合 code-agent 现在的成熟度。已有 session replay 和 review queue，可用较小模型升级打通常在线体验。

### 方案三：完整 always-on workspace

做法：

- 把 session 升级成 workspace-level work unit。
- 所有 chat、schedule、heartbeat、subagent、background、review 都进入统一 lifecycle。
- 提供全局 Activity/Inbox，支持暂停、继续、重试、订阅、通知、交付物和能力沉淀。
- Timeline 变成所有 work unit 的统一运行视图。

优点：

- 终态体验最好，产品心智统一。
- 对“生活和工作助手”更有想象力：用户不必区分聊天、自动任务、回看、评审，只看正在进行和已完成的工作。

代价：

- 范围大，容易牵动 scheduler、cron、review、activity、notification、subagent、workspace store。
- 如果先做这套，短期会把简单的 Cron sessionId linkage 拖成平台工程。
- 需要更强的信息架构，否则 Sidebar 会再次变成杂物入口。

适用场景：

- 适合在 typed session 跑通后再扩，不适合现在直接开干。

## 推荐优先级

1. 先做统一 session 类型，字段只覆盖 `type/origin/parentSessionId/sourceRunId/readonly`。旧数据默认 chat。
2. 让 Cron agent execution 反写 sessionId。Cron Center 能打开这次运行的 session，也能基于同一 job 重试。
3. 把 HEARTBEAT.md 运行从 `[Cron]` 视觉里抽出来，成为 `heartbeat` session；health heartbeat 保留在监控/告警语义里。
4. Sidebar 增加 type filter 和只读/generated 标记。Review 用 badge/filter，不做 type。
5. Timeline/Eval 只消费 type 和 origin，展示触发元信息。不要把 Eval Center 改成自动化管理中心。
6. subagent 先保持父 trace 中的可见性；只有当子 agent 具备独立 transcript、进度和输出时，再创建 `subagent` session，并挂 `parentSessionId`。

## 取舍

优先做 session type，因为它会补上当前系统最缺的“对象身份”。Cron、heartbeat、review、sidebar 都已经有半截能力；缺一层稳定 join key 的语义扩展。

不要先做完整 always-on workspace，因为那会把执行、调度、通知、评审和能力沉淀一次性卷进来。当前更该做的是把自动运行从“隐藏的聊天”变成“可识别的工作单元”。

也不要把 background 做成 type。用户把任务放到后台时，它仍然是原来的 chat/schedule/heartbeat session，只是状态变了。Background 适合放在 status/filter，不适合进类型枚举。

Review 同理。Review 是对 session 的二次分析和队列，不是原始工作发生方式。把 review 做成 type 会复制 session，破坏 replay identity。更好的方式是在 Review Queue 里维持 `sessionId + traceId`，在 Sidebar 上露出“已入评审”的标记。

## 最小落地切片

一个可验证的最小切片是：

1. 增加 session type 合同和 DB 默认值，所有旧 session 默认 chat。
2. Cron agent run 创建 `schedule` session，并把 `sessionId` 存到 execution。
3. HEARTBEAT.md run 创建 `heartbeat` session。
4. Sidebar 增加 Chat / Schedule / Heartbeat 过滤。
5. Cron execution detail 增加“打开运行 session”。

验收标准：

- 手动创建普通聊天，Sidebar 仍显示为 Chat。
- 新建并触发一个 agent cron job，Cron execution 里能看到 sessionId，并能打开对应 session。
- HEARTBEAT.md 注册的任务运行后出现在 Heartbeat 过滤下。
- Eval Center 可以对 schedule/heartbeat session 复用现有 replay/review 流程。
- Background session 在类型不变的情况下仍能被 Running/Background 状态过滤看到。
