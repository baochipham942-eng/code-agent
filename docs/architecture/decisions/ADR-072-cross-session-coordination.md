# ADR-072：跨会话协调协议——协调会话、委托链与确定性准入门

- 状态：**待拍板**（本单只出 ADR 不施工；施工卡由拍板后另立）
- 工单：N-WORKHUB-ADR（多agent线，wave 37）
- 相关：ADR-054（会话=指挥台——派活语义的上一拍）、ADR-047（主理人编排）、ADR-052（会话与专家的关系）、ADR-044（queued_inputs 排队输入——委托投递复用的表）、ADR-067（子代理 origin 链——**不覆盖**委托投递，R2 撤回「防洗白依据」这一用法）；在飞或待派单 N-BGSPAWN-DURABLE（刀1 已合 main）、N-LOOP-DURABLE-K2*、N-RUNENTRY-IDEMPOTENT、N-APPROVALWAIT-PAUSECLOCK
- as-built 基线：**origin/main@8c7dde035**（本文件所有 `标识符 @ 文件:行号` 均从该 commit 核出，不从工作树）
- 来源：`docs/competitive/maka-agent-2026-09-23-三周动向借鉴清单.md` §2（code-agent-private-archive 仓）；maka 源料 commit **d5bc0fad**，已拷贝至 `code-agent-private-archive/docs/evidence/assets/N-WORKHUB-ADR/maka-src/`（ADR、术语表、路由纯逻辑、准入门、协调器、协议、目标执行权威、崩溃恢复测试共 14 份）

## 背景：Neo 有「会话内指挥台」，没有「会话间协调层」

ADR-054（2026-08-04 已 accepted）把 Neo 的会话定为指挥台：前台 brain turn 用窄工具面（`delegate_task` / `steer_task` / `cancel_task` / `task_status`）把活派给**本会话的后台任务槽**，执行走账本任务，lane 串行 + submissionKey 幂等。这套派活语义已经落地（`SessionCommandCenter @ src/host/services/commandCenter/sessionCommandCenter.ts:116`，`spawn @ :151`）。

但它只覆盖一个会话内部。用户在 cowork 场景下的工作单位是**多个会话**（各有各的工作区、转录、产物和历史），今天想「把这句话送到对的会话去」只有一条路：自己记得哪个会话在干什么、手动切过去、手动粘贴。唯一跨会话的运行时行为是角色主动性（`wakeRole @ src/host/services/roleAssets/roleProactivity.ts:254` 起 schedule 会话，单向不回流）。`agentAppService.sendMessage @ src/host/app/agentAppService.ts:439` 能向任意会话投一条消息，但发行版主路径不走它：`webServer.ts:899` 的 `getAppService` 恒为 null，排队输入的生产投递是 `createWebQueuedInputDrain`（见 D5.1），没有协调层、没有准入门。

Apache Maka 09 月做了 WorkHub：每个 Runtime Host 一个隐藏的**协调会话**（Session 的一个角色，不是新实体），把用户消息路由四选一（就地回答 / 委托已有会话 / 新建会话 / 澄清），所有写操作先过**确定性准入门**，模型只出建议、无效输出一律回退澄清，停止/纠正/恢复沿**持久化委托链**走。本 ADR 回答 Neo 版协议的形状——借协议骨架，不抄代码。

### 现状全表（@8c7dde035）

> 「作用域」列是本 ADR 的关键分轴：**今天 Neo 所有派活/编排入口的作用域都是会话内**，没有一个入口能把活派给另一个会话。

| # | 入口 | 锚点 | 作用域 | 持久化 | 生产消费方 |
|---|------|------|--------|--------|-----------|
| 1 | `spawn_agent` / `AgentSpawn`（单+并行子代理；`engine` 外部引擎、`isolation: worktree`、`run_in_background`） | `executeSpawnAgent @ src/host/agent/multiagentTools/spawnAgent.ts:95`；schema 名 `spawn_agent @ src/host/tools/modules/multiagent/spawnAgent.schema.ts:180`、`AgentSpawn @ :191`、`engine @ :90`、`isolation @ :133`、`run_in_background @ :171` | 会话内（子代理树，深度默认 3 硬上限 5） | 并行 Team 走 durable_runs；后台单个走 `BackgroundSubagentDurableLedger`（见 #14） | 模型工具（compatibility 层） |
| 2 | `Task`（spawn 的兼容别名） | `name: 'Task' @ src/host/tools/modules/multiagent/task.schema.ts:39` | 会话内 | 同 #1 | 模型工具 |
| 3 | agent 间通信：`send_input` / `wait_agent` / `agent_message` / `teammate` / `collect_agent` / `close_agent` / `plan_review` | `send_input @ src/host/tools/modules/multiagent/sendInput.schema.ts:5`、`wait_agent @ waitAgent.schema.ts:5`、`agent_message @ agentMessage.schema.ts:5`、`teammate @ teammate.schema.ts:5`、`close_agent @ closeAgent.schema.ts:5`、`plan_review @ planReview.schema.ts:5`、`collect_agent @ collectAgent.schema.ts:5` | 会话内（同 run 的 agent 间） | SpawnGuard 队列（内存）+ teammateService 投影 | 模型工具 |
| 4 | `coordinatorMode`（3+ 并行 spawn 自动激活的任务编排） | `CoordinatorSession @ src/host/agent/coordinatorMode.ts:47`、阈值 `COORDINATOR_ACTIVATION_THRESHOLD @ :41`、激活 `shouldActivateCoordinator @ :302`、接线 `spawnAgent.ts:852-854` | 会话内（并行 spawn 内部） | ❌ 纯内存 Map | `executeParallelAgents` |
| 5 | `DAGScheduler`（Task DAG 并行调度） | `DAGScheduler @ src/host/scheduler/DAGScheduler.ts:149` | 会话内 | checkpoint 委托给 durable run | `parallelAgentCoordinator`、`toolExecution/dagScheduler.ts`、`orchestration/adapters/dagGraphSchedulerAdapter.ts` |
| 6 | `workflow`（命令式脚本编排）+ `workflow_orchestrate`（声明式 stage-DAG） | `src/host/agent/scriptRuntime/`；`src/host/agent/multiagentTools/workflowOrchestrate.ts` | 会话内 | `workflow_runs` / `workflow_run_calls` | 模型工具（复杂长任务默认路径） |
| 7 | goal 模式完成闸 | `handleGoalCompletionGate @ src/host/agent/runtime/goalCompletionGate.ts:66`（闸0 证据自证 + 闸1 确定性 verify + 闸2 软评审） | 会话内（goal 模式，可 allowSwarm） | turnTrace + `tool_execution_events`（append-only） | goal 模式运行时 |
| 8 | `taskManager`（会话任务清单） | `taskManagerModule @ src/host/tools/modules/planning/taskManager.ts:430` | 会话内 | taskStore（会话任务表） | 模型工具 |
| 9 | **会话命令中心**（ADR-054 指挥台的会话内落地） | 工具 `delegate_task @ src/host/tools/modules/commandCenter/sessionCommandCenter.schema.ts:12`、`steer_task @ :35`、`cancel_task @ :54`、`task_status @ :70`；执行 `executeDelegateTask @ src/host/tools/modules/commandCenter/sessionCommandCenter.ts:84`；服务 `SessionCommandCenter @ src/host/services/commandCenter/sessionCommandCenter.ts:116`（`spawn @ :151`，laneKey+submissionKey 幂等） | **会话内**（本会话的后台任务槽） | `SessionTaskSlotLedger @ src/host/services/commandCenter/sessionTaskSlotLedger.ts:79`（全局 4 / 每会话 2 / lane 串行）+ `BackgroundTaskLedger @ src/host/task/backgroundTaskLedger.ts:32` | 模型工具 + 成员视图 |
| 10 | 组队配方（主理人编排，ADR-047） | `launchTeamRecipe @ src/host/services/team/teamRecipeLaunchService.ts:334`、`validateTeamRecipe @ src/shared/contract/teamRecipe.ts:80`、`SwarmLaunchApprovalGate @ src/host/agent/swarmLaunchApproval.ts:33` | 会话内（lead 在当前会话轮拉成员） | swarm_runs + durable run | 产品入口 + `/命令` |
| 11 | `autoAgentCoordinator`（自动多 Agent 编排） | `AutoAgentCoordinator @ src/host/agent/autoAgentCoordinator.ts:82` | 会话内 | durable run（旧 JSON checkpoint 已删） | `autoAgentRunner`、`autoAgentRecoveryHost` |
| 12 | 角色主动性（cadence/event 唤醒） | `wakeRole @ src/host/services/roleAssets/roleProactivity.ts:254`、`syncCadenceJobs @ :629` | **跨会话但单向**（从角色资产建 schedule 会话，不回流协调） | history append + 会话 `origin=role-cadence` | cron + Stop hook |
| 13 | `/loop` 自主循环 | `LoopController @ src/host/loop/loopController.ts:103`；刀1 启动收口 `loopStartupRecovery @ src/host/loop/loopStartupRecovery.ts:2`（N-LOOP-DURABLE，PR#1683 已合） | 会话内自动循环 | `session_automations`（刀2 将建 `loop_runs`） | 用户命令 |
| 14 | 后台子代理 durable 账本 | `BackgroundSubagentRegistry @ src/host/agent/backgroundSubagentRegistry.ts:76`；`BackgroundSubagentDurableLedger @ src/host/agent/backgroundSubagentDurableLedger.ts:93`（N-BGSPAWN-DURABLE 刀1 / ADR-025 B1 + ADR-037，已合 main） | 会话内子代理转后台 | durable_runs：spawn 落账、租约 heartbeat、重启收口 `interrupted_by_restart`（不做断点续跑） | spawn_agent `run_in_background` |
| 15 | 账本数据层 | `RunStatus @ src/shared/contract/durableRun.ts:5`（8 态 + `RUN_STATUS_TRANSITIONS @ :17`）；`swarm_runs @ src/host/services/core/database/schema.ts:962` | 数据层 | SQLite | 上述所有入口 |
| 16 | **跨会话消息入口（AppService 通道，发行版未接上）** | `sendMessage @ src/host/app/agentAppService.ts:439`（`ConversationEnvelope @ src/shared/contract/conversationEnvelope.ts:168`） | 任意会话（进程内） | 消息经 sessionRepository 落库 | `agent.ipc.ts:85`、`planning.ipc.ts:146/:162`、`planApprovalService.ts:322/:355`；桌面 drain 里的调用（`desktopQueuedInputDrain.ts:124`）包在零生产调用方的 `registerDesktopQueuedInputDrain` 里。发行版 `getAppService @ webServer.ts:899` 为 null。排队投递的主人见 D5.1 |
| 17 | ACP 外部引擎会话 | `acpClientAdapter @ src/host/services/agentEngine/acpClientAdapter.ts` | 引擎层（外部 agent 引擎的会话） | 引擎自管 | 引擎适配（本 ADR 划界外） |

**读表结论**：#9 已经把「派活语义」（delegate/steer/cancel/status + 短名 + lane 串行 + submissionKey 幂等 + 歧义走 askUserQuestion）在会话内拍板并落地；#16 的 `sendMessage` 不是发行版排队投递的主人。**缺的是中间一层：决定「这句话该去哪个会话」的协调入口、防止派错的确定性准入门、以及记住「谁派给了谁」的委托链。** 投递复用既有 `queued_inputs` + `createWebQueuedInputDrain`（D5.1）。

## 三张图

### 图 1 · 委托链状态机

协调侧持久状态（`session_delegations.status`，含 `terminal_observed`）与目标会话执行状态（只读投影：`target_run_id` join durable_runs 的 `RunStatus`）是两套语言。`terminal_observed` 是协调层事实：投影看到目标 run 进入终态时把委托行写成这个状态（幂等、可重放），G4 就不再把已经完成的委托当成在飞。completed / failed / cancelled **不复制进委托行**，读取时 join。R1 曾把前台轮投影改挂 TaskManager，R2 撤回（前提为假，见修订记录）。

```mermaid
stateDiagram-v2
    [*] --> proposed: 协调 brain turn 产出建议
    proposed --> active: 准入门 G1-G12 全过，单事务提交：委托行 + queued_inputs 行（create_new 时含新会话行）
    proposed --> clarified: 门拒 或 模型输出无效，不落委托行，回协调会话澄清

    active --> superseding: 链上操作·纠正 correct
    superseding --> superseded: 新委托行落链，旧行 status=superseded
    superseding --> aborted: 新目标失格（归档/等待输入/消失）

    active --> stopping: 链上操作·停止 stop
    stopping --> stopped: 停止已送达（cancelled_pending / stop_delivered）
    stopped --> resuming: 链上操作·恢复 resume
    resuming --> active: 目标会话轮已起

    active --> terminal_observed: 投影到目标 run 终态时落表\\n(幂等、可重放；不复制 RunStatus)
    stopped --> terminal_observed: 同上，落表

    aborted --> active: 同一 queued_input 重发成功\\n投递复核通过且 G4 仍允许

    clarified --> [*]: 澄清回答作为新消息重新进入路由
    superseded --> [*]
    aborted --> [*]: retracted 或不重发
    terminal_observed --> [*]
```

**哪些迁移需要持久化**：`active` / `superseded` / `stopped` / `aborted` / `terminal_observed` 是协调侧持久状态，落 `session_delegations`。`terminal_observed` 在投影到目标 run 终态（`TERMINAL_RUN_STATUSES`：completed / failed / cancelled）时写入，幂等、可重放：已经是这个状态再写是空操作，崩溃没写上下一次投影补写。它记的是「协调层已观察到终态」，不把 RunStatus 复制进委托行；具体成败仍按 `target_run_id` 只读 join。G4 只数 `status='active'`，`terminal_observed` 不占单活名额。`superseding` / `stopping` / `resuming` 是链上操作的中间态，由操作自身的持久记录（stop 请求行 / 纠正行）表达，不单独立状态。`running` / `waiting` 等执行态**不落委托表**——它们是目标会话 durable_runs 的 `RunStatus`（`RunStatus @ src/shared/contract/durableRun.ts:5`，终态集合 `TERMINAL_RUN_STATUSES @ :15`）。`aborted(delivery_failed)` 不是终态：同一 `target_queued_input_id` 被重发、投递复核通过、且 G4 仍允许（该目标没有别的 `active` 委托）后翻回 `active`。`aborted(retracted_by_user)` 不再翻回。

**崩溃重启从哪恢复**：`active` 行本身就是恢复锚点。事务提交（委托行 + queued_inputs 行同 commit，见 D5.1）与 `markSending` 之间崩溃——行仍是 `queued` 且 `paused_reason IS NULL`，生产启动扫 `runStartupSweep @ src/web/routes/webQueuedInputDrain.ts:215`（接线 `agent.ts:326`，闸门 `webServer.ts:1094`）会补投。`markSending` 之后、`runAgentTurn` 返回前崩溃——`recoverSendingOrphans @ src/host/services/core/repositories/QueuedInputRepository.ts:247` 把行改回 `queued` 且 `paused_reason='restart'`，而 `listSessionsWithQueuedInputs @ :114` 与 `getNextDispatchable @ :125` 只取 `paused_reason IS NULL`，启动扫**不会**补投。这种行要等显式解停：目标会话用户 `sendNow`（`queuedInput.ipc.ts:212`），或协调层 `resume` 走同一条解停路径并先过投递复核。重复投递由 queued_inputs 主键幂等 + `markSending` 的抢占挡住。协调层**不建第二个恢复状态机**。`registerDesktopQueuedInputDrain` 的 `runStartupSweep @ desktopQueuedInputDrain.ts:170` 不是这条缝的主人（生产调用方 0）。

### 图 2 · 一条用户消息从协调会话到落地

```mermaid
sequenceDiagram
    actor U as 用户
    participant C as 协调会话<br>(Session 角色 · brain turn)
    participant R as 路由模型<br>(只出建议 · 两次小调用)
    participant P as 路由策略纯函数
    participant G as 委托准入门<br>(确定性 · 无模型)
    participant D as 单事务提交<br>(委托行+queued_inputs+新会话行)
    participant T as 目标会话轮

    U->>C: 消息 (ConversationEnvelope)
    C->>R: 意图分类 (用户文本 + 最近8条协调转录)
    R-->>C: 意图 JSON (routing/linked/unclear)
    alt 意图 = execute / continue
        C->>R: 召回排序 (≤32候选：不透明引用/短名/工作区/状态/新鲜度)
        R-->>C: ranked / ambiguous / none
    end
    C->>P: applyRoutingPolicy(意图, 召回)
    P-->>C: 四选一 disposition 或链上操作建议
    alt 模型输出无效 / 超时 / 空召回 / 歧义
        P-->>C: clarify (fail-closed，绝不 create_new)
        C-->>U: 反问澄清（回答作为新消息重新进入本图）
    else answer_here
        C-->>U: 就地回答（普通转录轮）
    else delegate_existing / create_new / 链上操作
        C->>G: 提案 (candidateRef, submissionKey, 受信用户文本)
        G->>G: G1-G12 确定性校验（查库/宿主构造，不查模型）
        alt 门拒
            G-->>C: 拒绝码 (target_unavailable / delegation_conflict / …)
            C-->>U: 澄清（带拒绝原因上下文）
        else 门过
            G->>D: 提交
            D->>D: 委托行(active) + create_new 新会话行 + queued_inputs 行
            D->>T: 提交后 createWebQueuedInputDrain 投递（空闲靠 handleEnqueued；runAgentTurn，不调 sendMessage）
            Note over D,T: markSending 前崩溃由 runStartupSweep 补投；之后崩溃行变 paused_reason=restart，不自动补投
            T-->>D: 轮终态（durable_runs RunStatus）
            D-->>C: 落表 terminal_observed（幂等），具体成败仍 join
            C-->>U: 委托卡片（进行中→终态）
        end
    end
```

### 图 3 · 协调会话、普通 Session 与会话内编排设施的关系

```mermaid
flowchart TB
    U[用户]

    subgraph COORD["协调层（本 ADR 新增）"]
        CS[协调会话<br>session_type = coordination<br>隐藏于普通会话列表]
        GATE[委托准入门<br>确定性 G1-G12]
        DG[session_delegations 委托链<br>协调层唯一新增表]
    end

    QI[queued_inputs 待处理输入<br>既有表复用（ADR-044）<br>createWebQueuedInputDrain 投递]
    RUN[runAgentTurn<br>buildQueuedAgentRunBody<br>前台轮写 durable_runs]

    subgraph SESSIONS["普通 Session（sessions 表）"]
        SA[会话 A]
        SB[会话 B]
    end

    subgraph INSESSION["会话内编排设施（全部不碰）"]
        SP[spawn_agent 子代理树<br>SpawnGuard]
        CM[coordinatorMode]
        DAG[DAGScheduler]
        WF[workflow / workflow_orchestrate]
        GG[goal_gate 双闸]
        TM[taskManager]
        SCC[SessionCommandCenter<br>delegate_task / steer_task<br>（会话内后台任务槽）]
    end

    subgraph LEDGER["既有账本（不新增）"]
        DR[durable_runs · RunStatus<br>终态投影的主人]
        SR[swarm_runs]
        BL[backgroundTaskLedger]
    end

    U -->|直接打开会话发消息| RUN
    U -->|在协调入口发消息| CS
    CS --> GATE
    GATE -->|入队（主键幂等）| QI
    QI -->|空闲 handleEnqueued / 释放后 handleReleasedSession| RUN
    CS --- DG
    DG -.->|terminal_observed 落表；RunStatus 只读 join| DR
    RUN --> SA
    RUN --> SB
    SA & SB -->|内部编排| INSESSION
    INSESSION --> LEDGER
```

三句话读图 3：协调会话**经准入门入队 queued_inputs**，由生产 drain `createWebQueuedInputDrain` 调 `runAgentTurn(buildQueuedAgentRunBody)` 投进目标会话，不另开通道，也不调 `sendMessage`；会话内编排设施（spawn_agent / coordinatorMode / DAGScheduler / workflow / goal_gate / taskManager / SessionCommandCenter）**原封不动**，协调层不知道它们的内部结构；账本分层——`session_delegations` 是协调层唯一新增表（投递复用既有 queued_inputs）。投影看到目标 run 终态时把委托行写成 `terminal_observed`（幂等）；completed / failed / cancelled 仍只读 join durable_runs（`target_run_id`），不读 TaskManager 的内存会话状态。

## 决策

### D1 · 协调会话 = Session 的一个角色，不是新实体

**决策**：复用 `sessions` 表的一个角色值（`session_type = 'coordination'`，或等价的 `origin` 标记——实施时按 `session_type` 语义扩张的代价二选一），不建新表、不建新会话类型实体。每个 App 实例一个协调会话，懒创建（第一次进入协调入口时 provision），重启后按角色值解析回同一个会话。

**理由**：
1. `sessions` 表已有承载角色的列：`session_type @ src/host/services/core/database/schema.ts:26`（现默认 `'chat'`）、`origin @ :27`、`parent_session_id @ :29`、`is_archived @ :40`、`is_deleted @ :39`、`metadata @ :28`。maka 用 `role` 字段走的就是这条路（其 ADR 原话："a special role of the existing Session, not a new durable entity type"）。
2. 复用即免费拿到全套基建：消息转录（sessionRepository）、恢复（`sessionStateManager` 本就支持多会话并行，`SessionRuntimeState @ src/host/session/sessionStateManager.ts:32` 注释明示）、模型配置、spine 投影（`transcriptProjector @ src/host/session/spine/transcriptProjector.ts`）、会话切换/恢复生命周期。
3. Neo 没有 maka 的 Runtime Host 概念，单机单 App 实例，「每实例一个」直接成立，不需要 maka 那层 per-Host 边界讨论。

**代价**（maka 同款，认下）：普通会话列表、搜索、导出、云同步、统计**每一处遍历会话的地方都要排除 coordination 角色**。漏一处 = 用户在列表里看见一个系统会话。缓解：列表查询收口到 SessionRepository 一个口子，排除规则放查询层不放调用方。

**为什么不是扩展 SessionCommandCenter 把目标从任务槽改成会话**：任务槽与 Session 是两种生命周期的实体——任务槽是短命执行单元（排队/跑/终态，并发池管理），Session 是持久工作单位（转录、工作区、记忆、产物）。委托的目标是后者。复用的是**派活语义**（delegate/steer/cancel/短名/幂等/lane），不复用**槽池实现**。

### D2 · 路由结果集合：四选一 + 链上操作，不建第五项「交给用户选择」

**决策**：新路由决策的封闭结果集 = `answer_here`（就地回答）/ `delegate_existing`（委托已有会话）/ `create_new`（新建会话再委托）/ `clarify`（澄清）。纠正 / 停止 / 恢复是**链上操作**（作用于既有委托），不是第五个 disposition——与 maka 的划分一致（maka 术语表："Linked operation … is not a routing disposition"）。

**「交给用户面选择」不单列**，理由有二：
1. maka 的已验证做法：目标选择是 `delegate_existing` **路径内部的一次交互**（协调模型在已入会话的轮内发布单选表单，用户点选后继续走准入门），不是路由结果。
2. ADR-054 决策 4 已经拍过同族问题：「歧义时走**既有 askUserQuestion 工具**确认……不新造确认交互」。直接继承：召回 `ambiguous`（≥2 个可信候选）时，协调 brain 用 askUserQuestion 出选项卡，选项值绑定不透明 candidateRef（显示名不参与绑定），10 分钟未答过期回落 `clarify`。

**cowork 场景对四选一的修正**：maka 的 `discuss`（就地回答）对应 Neo 的 `answer_here`，语义不变；`create` 必须来自用户显式要求新工作（maka 同款收紧：意图模型 prompt 明示 "create requires an explicit request for new work"），**任何失败路径都不得静默变成 create_new**——这是 cowork 用户（非程序员）被派错会话后最难自救的场景。

### D3 · 确定性准入门：G1-G12 运行时门全查库/宿主构造，G9 为结构性约束

**决策**：模型输出（路由建议、链上操作提案）永远只是建议；任何写操作（委托落账、停止、纠正、恢复）之前必须过准入门，门的判定项全部是确定性事实查询：

| # | 判定项 | 数据源 | 拒绝码 |
|---|--------|--------|--------|
| G1 | 目标会话存在且未归档未删除 | sessions 表 `is_archived` / `is_deleted` 直查 | `target_unavailable` |
| G2 | 目标可被委托：不是协调会话本身、不是子代理/计划唤醒/评测会话、不是外部引擎会话（`AgentEngineKind @ src/shared/contract/agentEngine.ts:10` 上一切 `kind !== 'native'`，含 manifest 尚未登记的新 kind——不只 ACP，也不按现有八个名字列举） | `session_type`；判据是 `agent_engine.kind !== 'native'`。**不**调用 `isExternalAgentEngine @ src/host/services/agentEngine/agentEngineGuards.ts:69`：它转到 `isManifestBackedExternalKind @ src/shared/externalEngineManifest.ts:597`，还要求 `adapter.adapterId` 有值，新 kind 没有 adapterId 会被当成可委托 | `not_delegatable` / `self_route` |
| G3 | 候选集新鲜：模型建议的 candidateRef 属于当前候选集快照 | candidateSetId = hash(候选会话集快照)，与建议携带的集合指纹比对 | `candidate_set_stale` |
| G4 | 无冲突在飞委托：同一目标会话至多一个 `active` 委托（v1 单活约束，见待拍板 Q3）。只数 `status='active'`；`terminal_observed` 已落表，完成过的委托不再占坑 | session_delegations 按 target 查 `status='active'` | `delegation_conflict` |
| G5 | 工作区边界：目标会话的 workspaceScope 必须可解析、且其根在用户授权目录集内（协调会话是隐藏系统会话、无 projectId 无工作区——`resolveSessionWorkspaceScope` 对它返回 undefined，R0 的「协调与目标一致」比较无比对象，删） | `resolveSessionWorkspaceScope @ src/host/services/sessionFork/workspace/resolveSessionWorkspaceScope.ts:22`（:40-42 无 projectId 返回 undefined） | `workspace_boundary` |
| G6 | 写互斥：目标工作区不得与**任何活跃写方**重叠——不只比其他 active 委托，还包括用户直开的其他会话正在该工作区跑轮（R0 只比委托行，看不见用户直开会话） | 活跃前台轮 = `RunRegistry.hasSession @ src/host/runtime/runRegistry.ts:896`（生产调用 `ipc/index.ts:220`、`webServer.ts:924`）。工作区取 `getBySessionId @ :867` 返回的 handle 的 `context.workspace`。跨会话枚举用 `list @ :940`（方法在，生产调用方 0，准入门是它的第一个调用方，不另造账本）。不读 `TaskManager.getSessionState @ src/host/task/TaskManager.ts:610`：未知会话默认 idle，web 主路径不写这张 Map（`:633-635`），发行版 `getTaskManager @ src/web/webServer.ts:910` 返回 null。目录重叠比工作区根；子代理先例是 `bindFileOwnershipReleaseHook @ src/host/agent/multiagentTools/spawnAgent.ts:114`（`ownedPaths @ :159`） | `write_conflict` |
| G7 | 幂等：submissionKey 已存在则返回既有委托结果；同键不同指纹拒绝 | session_delegations 唯一键 | `reused` / `idempotency_conflict` |
| G8 | create_new 的工作区上下文必须来自 Host 受信通道（当前授权目录），模型输出不得携带工作区或身份 | Host 侧构造 | `unauthorized_workspace` |
| G9 | 用户文本取自 ConversationEnvelope 原文（受信通道）；模型写的 delegationText 只是任务内容，不构成用户权威 | 入口投影 | （结构性约束，非运行时门——表内唯一不查库的一条） |
| G10 | 目标会话空闲：无活跃前台轮、无别的排队/发送中输入（人机争用——委托不得插进用户正在用的会话） | `RunRegistry.hasSession @ src/host/runtime/runRegistry.ts:896` 为真即忙（与 drain 的 `runRegistry.getBySessionId @ src/web/routes/agent.ts:308` 同一索引；已有活跃 run 时 `startDurable` 抛 `RunSessionConflictError @ src/host/runtime/runRegistry.ts:251`）。再加上 queued_inputs 里**其他** queued/sending 行（`hasQueuedUserInput @ src/host/services/commandCenter/foregroundWake.ts:60`）。不把 `getSessionState` 的非 idle 当判据（理由同 G6）。`hasActivePrimaryRun @ TaskManager.ts:637` 只是 `runRegistry.hasSession` 的包装，门直接读 registry | `target_busy` |
| G11 | 目标会话权限档不得高于 acceptEdits：委托文本不得送进 `bypassPermissions` 档的会话（防权限洗白） | `getModeForSession @ src/host/permissions/modes.ts:334`（生效档，含 unattended/首跑/限流钳制）；先例：无人值守钳档 `clampUnattendedPermissionMode @ :749`（不得高于 acceptEdits）、B1 收口 `sessionManager.ts:258-262`（cron/heartbeat/channel 标 unattended 强制钳档） | `target_permission_mode` |
| G12 | folderTrust：create_new 的新工作区与 delegate_existing 的目标工作区都要过信任评估（生产 drain 不调 folderTrust，须在准入门与投递复核这两步调） | `evaluateFolderTrust @ src/host/security/folderTrustService.ts:857`。非 trusted 且 blockedItems>0 一律拒绝回澄清，用户显式确认后才放行。**评估抛错或拿不到结果也拒绝**（同一拒绝码）。这与 `ensureFolderTrustForSpaceCreation @ src/host/services/project/projectService.ts:526-530` 相反：那里 `catch` 后得到 undefined，`:530` 直接 return，创建继续（注释 `:519`：用户亲手选的目录，扫描故障不阻断）。协调建议的目录不是用户亲手选的，评估失败等于信任未知，未知必须拒 | `untrusted_workspace` |

G7 的幂等键直接沿用 #9 已在生产验证的形状（`SessionCommandCenter.spawn` 的 laneKey + submissionKey）；maka 的 action fingerprint（sha256 绑定 操作+目标+载荷）作为同键冲突时的判别器。

**候选集的构造**（G2/G3 的输入）：`is_archived=0 AND is_deleted=0 AND session_type='chat'`——按 `session_type` 白名单收口：`SessionType @ src/shared/contract/session.ts:21` 的值域是 `'chat' | 'schedule' | 'heartbeat' | 'subagent' | 'eval'`，其中 schedule/heartbeat 是角色唤醒会话（单向不回流）、subagent/eval 是系统会话，一律不进候选。R0 用 `parent_session_id IS NULL` 判子代理是误伤：**用户手动分叉的会话也是 `parent_session_id=sourceSessionId` 且 `session_type='chat'`**（`SessionForkRepository.ts:274-294`，:283 字面量 'chat'、:294 写 parent_session_id）——该过滤会把用户分叉会话全挡掉；子代理会话由 `session_type` 白名单 + G2 引擎判定双重排除，不再依赖 parent_session_id。按最近活动排序截断（maka 上限 32 个，沿用），每项只含：不透明引用（候选集内稳定、跨集合不稳定）、短名、工作区短名、状态、新鲜度桶。**stable sessionId 不进模型输入**——模型只能引用它看过的候选集里的 opaque ref，由 Host 反查（maka 同款："Proposals never carry a Session id"）。

### D4 · 模型只出建议的契约

**输入**（两次独立小调用，全部截断有界）：

| 调用 | 输入 | 上限 |
|------|------|------|
| 意图 | 用户文本（≤2000 字）+ 最近 8 条协调转录（每条 ≤600 字） | 输出 ≤80 token，0 重试 |
| 召回 | 用户文本 + 意图结果 + ≤32 候选（不透明引用/短名/工作区名/状态/新鲜度桶） | 输出 ≤160 token，0 重试 |

界值取 maka 代码值（输入界值 `WORKHUB_ROUTING_MAX_*` @ 其 `workhub-routing.ts:43-46`，输出上限 80/160 @ 其 `execution-model-authority.ts:253/:275`；该路由模型生产未接电，两组界值均出自未通电的代码常量而非生产观测）；意图看不到候选，召回看不到 stable 会话身份——两者都不能单独授权任何写。

**输出**：严格 JSON，白名单解码（多余键、未知值、超集引用一律抛错）：
- 意图标签集（8 值，与 E1 评测口径一一对应）：`routing{discuss|execute|create|continue}`（四路由值）/ `linked{correct|stop|resume}`（三链上值）/ `unclear`
- 召回三值：`ranked[refs]`（首个为明确最佳）/ `ambiguous[refs]`（≥2 可信）/ `none`

**策略是纯函数**（决策表，单测锁死）：

| 意图 | 召回 | disposition |
|------|------|-------------|
| unclear | — | clarify |
| linked | — | 对应链上操作提案 |
| discuss | — | answer_here |
| create | — | create_new |
| execute / continue | ranked | delegate_existing（该候选） |
| execute / continue | 其他一切 | clarify |

**失败回退**：解析失败 / 超时 / provider 错误 / 候选不可用 / 空召回 / ambiguous 未被用户选择 —— 全部 fail-closed 到 `clarify`，**没有一条路径静默变成 create_new 或绑定任意会话**。超时建议 5s（Neo 侧先例：research 线意图分类从 8s 优化到 3s；路由是两次串行小调用，给 5s 总预算），落 `shared/constants`。

**绑定与恢复**：路由决定落协调轮的 turn metadata（bound decision），同轮后续工具提案与它不符即拒；崩溃恢复的续跑轮复用该决定，不重新路由（maka："Every fresh root receives its own decision"，排队跟进与恢复轮各得各的决定——即恢复轮拿的是**当初的决定**，不是新决定）。

**默认路由模型**：协调会话自己保存的模型（复用连接与 thinking 设置，零额外配置）。maka 的 `createHostWorkHubRoutingModel` 在生产**未接电**（只有测试夹具注入，其 ADR 自述「证据齐之前不改默认策略」）——Neo 的两步走见 D6。

### D5 · 委托链持久化：链接，不是转录副本

**决策**：新表 `session_delegations`，一行 = 一条委托链节：

```sql
CREATE TABLE IF NOT EXISTS session_delegations (
  delegation_id     TEXT PRIMARY KEY,
  coordination_session_id TEXT NOT NULL,
  coordination_turn_id    TEXT NOT NULL,
  disposition       TEXT NOT NULL,          -- delegate_existing | create_new
  target_session_id TEXT NOT NULL,
  target_message_id TEXT,                   -- 投递落定的消息 id（软链接，可因压缩/rewind 失效，见下）
  target_queued_input_id TEXT,              -- queued_inputs 行 id（投递幂等主键；行在消息消失后仍存活）
  target_run_id     TEXT,                   -- onDurableActivated 回填的 durable_runs.run_id；投影主键。提交时还没有 run，不参与身份锚
  submission_key    TEXT NOT NULL UNIQUE,   -- 幂等键：协调会话+轮+提案指纹
  action_fingerprint TEXT NOT NULL,         -- sha256(操作+目标+载荷)，同键判别器
  status            TEXT NOT NULL,          -- active | superseded | stopped | aborted | terminal_observed
  supersedes_delegation_id TEXT,            -- 纠正链：新行指向旧行
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolution_json   TEXT                    -- stop/correct 的终态事实（outcome 等）
);
```

**关键约束**（maka "Delegation links rather than copies transcripts" 的同款纪律）：
- 委托行只存**有界链接**（协调轮 ↔ 目标会话/消息/排队输入/run），不复制目标会话的执行状态与转录；`running` / `waiting` / 终态是 join durable_runs 的**只读投影**（键 = `target_run_id`，读 `DurableRunRepository.get @ src/host/services/core/repositories/DurableRunRepository.ts:151`）。不用 `getLatestBySession @ :156` 当投影键：它返回该会话最新一行，委托之后用户再发一条就会指错。会话变更通知失效后按 `target_run_id` 重建。R1 删掉 `target_run_id`、改挂 TaskManager，R2 撤回：前提为假。
- 协调状态与执行状态分离：`status` 表达的是**链**的生死（active / superseded / stopped / aborted / terminal_observed），不是目标活的成败——目标活的成败属于目标会话，按 `target_run_id` join。`terminal_observed` 只表示已观察到终态，不保存 completed / failed / cancelled。
- **单事务提交边界**（落到真实表见 D5.1）：委托行（session_delegations）+ queued_inputs 行 + create_new 的新会话行（sessions），一个 SQLite immediate 事务；提交前互不可见，提交后同时存在。投递（drain）只发生在提交之后。

**崩溃恢复入口复用什么**：不建第二个恢复状态机。三段接缝各有既有主人——(a) 提交与 `markSending` 之间：行仍是 `queued` 且 `paused_reason IS NULL`，生产启动扫 `runStartupSweep @ src/web/routes/webQueuedInputDrain.ts:215` 会补投（接线见 D5.1）。`markSending` 之后崩溃不在这条补投里：`recoverSendingOrphans` 把行标成 `paused_reason='restart'`，启动扫看不到它，要显式解停。R0 曾把这段引到 `BackgroundSubagentDurableLedger`，该账本文件头 `:14-16` 是完成时 checkpoint、`:17-20` 是重启**收口成 interrupted_by_restart 不续跑**。R1 改引 `registerDesktopQueuedInputDrain`，该函数在 8c7dde035 上只有定义、生产调用方 0。两轮都锚到没接电的东西；(b) 委托行残留 active 而协调会话轮已死：启动扫 `status='active'` 且无对应在跑轮的行，按 N-LOOP-DURABLE 刀1 的收口语义投影「中断事实」给协调会话（收口不续跑；续跑是 `resume` 链上操作的事）；(c) 目标会话自身的崩溃恢复：事实在 durable_runs（默认 rollout `durable_preferred`，`resolveDurableRunRollout @ src/host/app/durableRunRollout.ts:39`，`durableActivation @ :57` 在非 legacy 时为真）。`recovering` 是 `RunStatus @ src/shared/contract/durableRun.ts:10`。协调层只读 `target_run_id`。不读 `TaskManager.sessionStates`。

**链的持久锚与三种失效**（R1 新增，R2 补 `target_run_id`）：链的身份锚 = `delegation_id`（主键）+ `target_session_id`（sessions 行稳定）+ `target_queued_input_id`（queued_inputs 行在消息消失后仍存活——`markConsumed` 只 UPDATE status 不删行，且生产 drain 送达时它就是消息的 clientMessageId，`drainOne @ src/web/routes/webQueuedInputDrain.ts:159` 重建 envelope 带 `clientMessageId: record.id`）。`target_run_id` 不是身份锚：提交时 run 还不存在，起轮后由 `onDurableActivated @ src/web/routes/agent.ts:530` 回填（drain 把回调从 `:312` 传进来），之后投影只 join 这一列。回填不限于这一条 drain：INV-4，任何能把协调来源行送进目标会话的入口都要回传本次激活 run 的 id。投影看到终态时把本行写成 `terminal_observed`（幂等、可重放），不把 RunStatus 复制进来。`target_message_id` 降级为**软链接**：消息行消失或被隐藏时投影降级为「目标已前进」，链本身不断（委托行的身份不依赖消息存活）。fork 后委托**不跟到子会话**：fork 换新 id 新会话行、不复制 session_delegations，链停在源会话并投影「目标已分叉」（fork 的 `forkLineage` metadata 可 join 出 childSessionId，`SessionForkRepository.ts:293`，文件在 `src/host/services/core/repositories/`），用户要继续就显式发新委托（新行 supersedes 旧行）——不让链静默漂移到用户没确认过的目标。三种失效各一行：

| 发生 | 链状态 | 用户看到什么 |
|------|--------|--------------|
| 目标会话手动压缩（`replaceMessages @ src/host/services/core/repositories/SessionRepository.ts:635`：:662 整表 DELETE 后 :670-677 重插；入口 `contextHealth.ipc.ts:561`） | target_message_id 指向的行被删 | 委托卡片显示「目标已前进（转录已压缩）」，链与终态事实仍在 |
| 目标会话 rewind（`hidden_by_rewind_id @ src/host/services/core/database/schema.ts:97`；`hideProjectionSuffix @ src/host/services/core/repositories/SessionRewindRepository.ts:359` 软隐藏不删行，调用点 `:160`） | target_message_id 指向 `visibility='rewound'` 的行 | 委托卡片显示「目标已回退」，终态投影以 rewind 后的转录为准 |
| 目标会话被分叉（换 id，子会话无委托行） | 链停在源会话，status 不变 | 委托卡片显示「目标已分叉」，提示可向新会话显式发新委托（resume 语义） |

**与在飞单的关系**：
- **N-BGSPAWN-DURABLE**（刀1 已合 main）：委托链**依赖**它的接缝语义但不吸收它——它管「后台子代理的 durable 收口」，本 ADR 管「会话到会话的链接」，表不同、恢复入口不同。它的刀2（断点续跑，若立项）同样不被本 ADR 吸收。
- **N-RUNENTRY-IDEMPOTENT**（排队中）：目标是「客户端重试不重复起 run」。R1 起委托投递复用 queued_inputs，其 `INSERT OR IGNORE` + 主键幂等（`enqueue @ src/host/services/core/repositories/QueuedInputRepository.ts:62`）已是这类幂等的既有生产实例；该单落地后统一收口到共享幂等层，协议侧键形状对齐即可。**建议排序：本 ADR 的协议落地不 block on 它，接电前对齐。**
- **N-LOOP-DURABLE-K2***（排队中）：互不吸收。loop_runs 管循环轮次恢复，session_delegations 管委托链；两者共用「启动扫描收口 + 显式恢复操作」的框架思路（照 agent_wakes 模式），表与触发器各自独立。
- **N-APPROVALWAIT-PAUSECLOCK**（排队中）：无直接依赖；若落地，目标会话 waiting 态的时长口径以它为准，本 ADR 的 `waiting` 投影只读该口径。

### D5.1 · 委托投递路径：走既有 queued_inputs，不另建待处理表（R1 新增）

**决策**：委托消息进目标会话走既有 `queued_inputs` 表（ADR-044 D1，`queued_inputs @ src/host/services/core/database/schema.ts:1084`），不新建「目标会话待处理消息」存储——「协调层唯一新增持久化 = session_delegations 一张表」的自述由此成立：投递是**复用**既有表，不是新增。

**单事务提交边界（真实表）**：一个 SQLite immediate 事务 = session_delegations 行 + queued_inputs 行 +（create_new 时）sessions 行。create_new 的 Project 边界解析（`ensureProjectForWorkspace`，异步且自身有写）与 G12 的 folderTrust 评估都放在事务**前**完成。会话行不手写 INSERT：走 `createSession @ src/host/services/infra/sessionManager.ts:197`，把三处插入放进它的 `options.commit` 回调（类型 `:77`，调用点 `:256`：`options.commit(() => db.createSession(session))`）。回调在异步的 git 探测（`:203-214`）和 Project 解析（`:241-254`）之后同步执行，所以协调层的事务包在这个回调里：`writeSessionRow` + 委托行 + queued_inputs 行，一次 better-sqlite 同步事务。先例是 `CompanionLibraryService.mutate` 的 `session.create`（`CompanionLibraryService.ts:196`）。权限档初始化在回调返回之后（`:258-273`），失败被吞掉（`:271-272`）；G11 的投递复核读 `getModeForSession`，缺档会在投递前被挡住，不靠事务本身。

**入队形状**：`queued_inputs.id = 'delegation:' + submission_key`（确定性派生）。`enqueue @ src/host/services/core/repositories/QueuedInputRepository.ts:62` 是 `INSERT OR IGNORE` + 主键幂等——崩溃重放不重复入队；`position = MAX(position)+1`——委托排在已在队的用户输入**之后**（`ORDER BY position ASC, created_at ASC, id ASC`，FIFO 不插队）。id 前缀不是权威：renderer 的 enqueue 自己选 id（`useChatInputSubmit.ts:77`）。权威是指向该 id 的 `session_delegations` 行。

**投递执行的主人**：`createWebQueuedInputDrain @ src/web/routes/webQueuedInputDrain.ts:88`，唯一生产装配点 `src/web/routes/agent.ts:300`。它不调 `sendMessage`。`drainOne @ :146` 取 `getNextDispatchable`，`markSending @ :150`，然后 `runEnvelope`（`:168`）——装配成 `runAgentTurn(buildQueuedAgentRunBody(envelope))`（`agent.ts:310`）。空闲会话靠 `handleEnqueued @ webQueuedInputDrain.ts:198`，接线 `agent.ts:327`；入队 IPC 在写入后调 `onEnqueued`（`queuedInput.ipc.ts:142`，重发 `:200`），`webServer.ts:915` 把它接到这个 hook。一轮结束靠 `handleReleasedSession`（`agent.ts:1340-1343`）。启动扫是 `runStartupSweep @ webQueuedInputDrain.ts:215`，经 `agent.ts:326` 注册到 `webServer.ts:1094`。

桌面端没有第二条「入队即投」主进程。发行版是 Tauri + webServer（`webServer.ts:513`；`setupAllIpcHandlers` 的生产调用方只有 `webServer.ts:937`，`session.ipc.ts:8`）。`getAppService` 与 `getTaskManager` 在这套装配里都是 null（`webServer.ts:899`、`:910`）。renderer 负责入队（`useChatInputSubmit.ts:82-85`）和人手 `sendNow`（`QueuedInputTray.tsx:54`），不负责空闲自动抽干。`registerDesktopQueuedInputDrain @ desktopQueuedInputDrain.ts:52` 会调 `sendMessage`（`:124`），但生产调用方是 0（只有测试），本 ADR 不把它当主人。所以桌面与 web 共用这一条 drain，不另开「桌面投递缺失」的待拍板槽。

**失败与重发**：投递失败走 `requeueAfterFailure`，至 `QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS = 3`（`src/shared/constants/queuedInput.ts:3`）耗尽后 `markFailed`（默认 `paused_reason='send_failed'`，`QueuedInputRepository.ts:165`）+ `QUEUED_INPUT_SEND_FAILED`。这时委托行投影 `aborted(delivery_failed)`，但 **aborted 不是终态**。自动重试不改载荷。协调来源行上，用户 `requeue` 不得改 INV-5 的载荷，也不得把已撤回行复活为委托（INV-6）；要改内容或重发已撤回的委托，就另发一条普通用户消息。同一 `target_queued_input_id` 上、载荷未改的重发若投递复核通过、G4 仍允许、并起了轮，委托行从 `aborted(delivery_failed)` 翻回 `active`，`target_run_id` 改记新 run。用户撤回投影 `aborted(retracted_by_user)`，这条不再翻回。

**委托文本的权威**（R2；R3 起第 2、3 条只定不变量，落点由施工卡定）：

1. **必须带协调来源标记，在投递层校验。** `buildQueuedAgentRunBody @ agent.ts:121-134` 的白名单没有 origin。`context` 会原样进 `AgentRunBodySchema`（`agentBodySchemas.ts:12` 是 passthrough），但普通轮在工具执行时铸的是用户 origin（`mintUserTurnOrigin @ src/host/agent/messageOrigin.ts:90`，调用点 `toolExecutionEngine.ts:816`）。ADR-067 的 origin 链只挂在子代理循环上（`collectTurnOrigins` 的写入 `subagentExecutor.ts:580`，权限参数 `turnOrigin @ :937`），委托不经过。所以送达后的委托就是一条普通用户消息，D5.2 不再用 ADR-067 当防洗白依据。决定：协调事务写入 `envelope_json.context.coordinationOrigin = { delegationId, actionFingerprint }`（模型不写这个字段）。施工项是扩展 `buildQueuedAgentRunBody`，把标记送进 run，并且该轮不得再铸成纯用户 origin。校验不在「字段出现了」：renderer 的 enqueue 可以伪造 envelope。投递前用 `session_delegations` 对行。有委托行指向这个 id：`action_fingerprint` 必须对上 INV-5 点名的载荷字段，对不上就暂停（`paused_reason=payload_mismatch`）并投影，不把改过的载荷当用户消息投出去。没有委托行：标记不当权威，剥掉标记后按普通用户消息投出，不授予协调身份。
2. **用户改委托行。**
   - **INV-5** 协调来源行的载荷不可被任何 renderer / IPC 路径覆写。`update` 与 `requeue` 一视同仁：后者用 composer 内容整体覆写 envelope，并且能把已撤回行拉回 queued。载荷指纹覆盖 `content`，以及 `attachments` 的引用（id / 路径，不含二进制）。`options.modelSpec` **排除**：宿主在入队和重发时按目标会话的当前模型档重写它，renderer 原来带的值不算数；它不是准入门校验过的委托正文，放进指纹会把每一次合法重发判成 `payload_mismatch`。
   - **INV-6** 已撤回（retracted）的协调来源行不可复活为委托。用户要重发，就是一条普通用户消息。
   - 重排允许，它不改载荷。撤回允许，并投影 `aborted(retracted_by_user)`。
3. **投递时复核。** 不指定函数落点。
   - **INV-1** 复核必须发生在该行被任何投递路径抢占（claim / markSending）之前。自动 drain 与用户 `sendNow` 同一条规矩。做不到先复核再抢占的入口，不得投递协调来源行。
   - **INV-2** 复核只看目标是否有活跃 run，以及 G1、G2、G11、G12。不把排在本行之后的用户输入算作忙——否则委托被暂停，后面的用户消息跟着卡死。
   - **INV-3** 复核红时暂停本行并投影给协调会话。调度必须继续抽下一行，不得因本行暂停而停摆。抢占之后才发现目标已有活跃 run 的，同样暂停并投影，不放回自动重试。
   - **INV-4** `target_run_id` 的回填是投递路径的义务：任何能把协调来源行送进目标会话的入口，都必须回传本次激活 run 的 id。做不到回填的入口不得投递协调来源行。

**与前台唤醒跳过规则相容**：`hasQueuedUserInput @ src/host/services/commandCenter/foregroundWake.ts:60`（:68-69 见 queued/sending 即真）会让命令中心的前台唤醒跳过该会话（:148-149）——委托输入在队期间，该会话的后台任务完成**不触发前台唤醒**，直到 drain 消费完。这是既有规则对一切排队输入的统一行为（用户自己排队时同样发生），方向是安全的（防唤醒轮与排队输入交错），本 ADR 接受并沿用，不开例外。

**与 G10 的两段**：提案时 G10 红，委托不落行，回澄清。落行之后的忙闲改看 INV-2：只看目标有没有活跃 run，不把排在本行之后的用户输入算作忙。复核红则暂停并投影，不静默排到用户后面再投。`sessionAutomationService.ts:663-680` 忙则留言不打断，说的是自动化交接，不是这条投递。

**恢复语义**：`paused_reason IS NULL` 的 queued 行，启动扫会补投。`paused_reason='restart'`（行被抢占之后崩溃）或投递复核写下的拒绝码，启动扫不投。解停（用户 `sendNow` 或协调 `resume`）必须先满足 INV-1 到 INV-4，再投递。`aborted(delivery_failed)` 翻回 `active` 时，复核在 INV-2 的项之外再加上 G4：同一目标已有别的 `active` 委托则不翻回。这与接缝 (b) 委托行残留 active 的收口（投影中断事实、续跑靠显式 resume）不是同一段。不要把「行还在」写成「runStartupSweep 会补投」。

### 施工前置（本 ADR 不定落点，施工卡必须逐条关账）

R3 起 D5.1 只定不变量，落点由施工卡定。下面每条是施工卡必须关账的缺口。

- 仓储缺「queued 行加暂停原因」的通用方法。（N1）
- drain 依赖缺复核钩子。（N1）
- `update` / `requeue` IPC 缺反查委托行的注入。（N1 / I3）
- renderer queued-edit 入口对协调来源行要隐藏。（N1）
- `sendNow` 空闲分支不传 `onDurableActivated`。（I2）
- `hasQueuedUserInput` 模块私有且计入已暂停行，门不能直接复用。（N3）
- 协调来源标记要走带外字段或在非队列入口剥掉（直调 /agent 的 context 透传可伪造）。（N2）
- `drainOne` 暂停后继续调度。（I4）

### D5.2 · 审批卡的归属与协调侧可见性（R1 新增）

**事实**：审批 park 按会话——`approvalParkEvents @ src/host/agent/approvalParkEvents.ts:31`（parked 事件总线）；`TaskManager.ts:296-298` 的注释明示后台 run 的「消息与审批仍归属原 sessionId」；启动重水化 `hydrateApprovalGatesAtBoot @ src/host/agent/parkedApprovalHydration.ts:26`。companion 手机端已有按会话渲染的 ApprovalCard（`packages/mobile/src/features/sessions/ApprovalCard.tsx:4`，`MobileRoot.tsx:674` 渲染）。

**决策**：委托轮触发的审批卡**留在目标会话**，协调层不搬卡、不代答。R1 写的「委托文本按 ADR-067 D3 带 origin 链」不成立：那条链的生产挂载点在子代理循环（`subagentExecutor.ts:580` 与 `:937`），委托走的是 `runAgentTurn(buildQueuedAgentRunBody)`，白名单没有 origin，普通轮铸用户 origin（见 D5.1）。防洗白靠 G11（提案时拒绝 `bypassPermissions`）加上 INV-2 再跑一遍 G11，加上协调来源标记不得被当成用户权威。在 `buildQueuedAgentRunBody` 把标记送进 run 之前，运行时还没有这条保护，协议不能假装已经有了。

**协调侧感知**：只读投影「目标等待审批」（waiting 语义，时长口径归 N-APPROVALWAIT-PAUSECLOCK）；委托卡片给「去目标会话处理」的跳转，不在协调会话里复刻审批交互——协调会话的工具档本来就不含审批面，防协调层长成执行体。用户也可以在 companion 上答目标会话的审批卡（既有能力，无需新做）。协调入口/委托卡片要不要进 companion，列为待拍板 Q7。

### D6 · 两步走：协议先落地、默认不接电，接电判据可测

**决策**：像 maka 一样分两步。第一步（协议落地）：表 + 准入门 + 路由适配器（fail-closed）+ 协调会话角色 + feature flag（建议 `sessionCoordination`，默认 off），合 main 但用户不可见。第二步（接电）：flag 默认 on，前置判据如下——**全部可测，无形容词**：

| # | 判据 | 阈值 | 怎么测 |
|---|------|------|--------|
| E1 | 路由意图准确率 | ≥200 条评测集上意图标签 **8 值**（routing{discuss/execute/create/continue} + linked{correct/stop/resume} + unclear，与 D4 输出集一一对应）准确率 ≥85%，且分层配额达标：execute/continue 合计 ≥40%、create ≥5%、discuss ≥15%、linked ≥15%、unclear ≥10% | 评测集来源（协调入口未上线、无真实协调消息可采，用代理语料）：①从本机既有真实会话历史抽多会话快照、人工改写出「跨会话意图」样本（候选集快照按 G3 同 schema 从真实会话表构造，≤32 个）；②人工新写。金标 = 单人标注 + 20% 抽样双标（另一人/另一模型席），一致率 ≥90% 才收卷。Neo 既有 eval 框架跑（不建协调专用评测框架，maka 同款决策） |
| E2 | 不安全绑定 | **= 0**：把 execute 派给错误会话、或任何失败路径产出 create_new/任意绑定 | 评测集断言 + 准入门拒绝路径单测全覆盖 |
| E3 | 崩溃幂等 | 两个注入点各 ≥10 次、合计 ≥20 次，都打在生产投递路径上：①**行被抢占前**。断言：行仍是 queued 且 `paused_reason IS NULL`，启动扫会再抽到它，重复投递 0（主键幂等 + 抢占）。②**行被抢占后、轮返回前**。断言：行留成 queued 且 `paused_reason='restart'`；启动扫不抽它，自动补投 = 0；行不被删。解停只来自用户 sendNow 或协调 resume，且先过 INV-1 到 INV-4。不再断言「丢委托 0 靠启动扫补投」 | fault-injection 档测试（`docs/testing-evidence-classes.md` 口径）。不使用生产调用方为 0 的桌面 drain |
| E4 | 多余澄清率 | 评测集上不必要的 clarify ≤20%（「不必要」= E1 金标判为可路由却 clarify） | 同 E1 评测集与金标流程，标注人同 E1 |
| E5 | 路由延迟 | 端到端路由决策 P95 ≤3s（两次小调用 + 候选查询） | 评测集计时 |
| E6 | 准入门真实工作 | flag 内测期 ≥500 条路由消息中拒绝码分布非全零、且 ≥2 种不同拒绝码被触发（门在真实使用中被触发，不是摆设） | flag 内测期打点 |

不满足 E1-E4 任意一条：不接电，回评测迭代；E5/E6 不满足：可以带病接电但必须立单。

## 与五个既有编排设施的关系（吸收 / 并存 / 不碰）

| 设施 | 关系 | 一句话 |
|------|------|--------|
| `coordinatorMode`（`CoordinatorSession @ src/host/agent/coordinatorMode.ts:47`） | **不碰** | 它是并行 spawn 内部的内存任务编排（3+ agent 自动激活）；协调层永远不进 spawn 树，协调会话的工具档**禁含 spawn_agent**（防协调层自己变成执行体） |
| `spawn_agent`（`executeSpawnAgent @ src/host/agent/multiagentTools/spawnAgent.ts:95`） | **不碰、不吸收** | 委托的目标是 Session，子代理树继续是会话内设施；`run_in_background` 的 durable 账本（#14）与委托链各自独立，表不同恢复入口不同 |
| `DAGScheduler`（`DAGScheduler @ src/host/scheduler/DAGScheduler.ts:149`） | **不碰** | 会话内 DAG 执行调度层（`webStartupServices` 注入 resolver）；协调层只选会话、不调度 DAG，两者的「依赖」语言不共享 |
| `goal_gate`（`handleGoalCompletionGate @ src/host/agent/runtime/goalCompletionGate.ts:66`） | **不碰** | goal 完成闸是会话内 goal 模式的语义；委托的「完成」= 目标轮的 durable_runs 终态（`completed` / `failed` / `cancelled`，按 `target_run_id` join），**不引入第二把完成闸**——协调层无权判定目标的活算不算完成 |
| `taskManager`（`taskManagerModule @ src/host/tools/modules/planning/taskManager.ts:430`） | **并存** | 协调会话作为 Session 可以用自己的任务清单记协调待办（可选）；委托不读写目标会话的 taskStore，两套任务语言不合并 |

另与 **ADR-054 会话命令中心**（#9）的关系是**分层并存**：它管「会话 brain → 本会话后台任务槽」，本 ADR 管「协调会话 → 其他会话」；派活语义（delegate/steer/cancel/短名/幂等/lane）同族同源，实现分体（槽池 vs 委托链）。用户在一个普通会话里说「帮我做 X」走它；在协调入口说「让那个做 X 的会话继续 Y」走本 ADR。

## 划界（不做什么）

- **不做多 Host / Mesh / 云同步协调**。单机单 App 实例是全部前提；跨设备协调（两台机器各开一个 Neo 互相同步委托）明确不在本 ADR，maka 也只做到 per-Host。
- **不动会话内编排的内部**。上面五个设施 + workflow 的内部结构、schema、语义一概不改；协调层对它们只有「目标会话的轮终态」这一个只读接口。
- **maka 的 model routing ≠ Neo 的 modelRouter**。maka「routing」指用模型把消息分派到会话；Neo `modelRouter` 是按任务选推理模型。两词在本 ADR 语境中不混用——本文「路由」一律指前者。
- **协调会话不做执行**。工具档禁 `spawn_agent` / `workflow` / `delegate_task`（会话内指挥台工具）等一切「自己把活干了」的口子；它只能回答、澄清、委托、链上操作。防协调层长成又一个执行体。
- **外部引擎会话不作为委托目标**（G2 拒绝，判据 `kind !== 'native'`，覆盖 `AgentEngineKind @ src/shared/contract/agentEngine.ts:10` 上现有的 codex_cli / claude_code / mimo_code / kimi_code / kimi_code_acp / codebuddy_code / grok_cli / dsh_cli，也覆盖以后新加、manifest 里还没有 `adapterId` 的 kind。不用 `isExternalAgentEngine`，见 G2）：其轮生命周期由外部引擎驱动，待处理消息语义无保证。将来若开放，另立 ADR。
- **不做 L3 agent 间对话**（沿用 multiagent-system.md 的 L0-L3 分级决策）；协调会话与目标会话之间只有消息投递与状态投影，没有对话。

## 风险

- **「遍历污染」是复用 Session 角色的持续税**：每处新加的会话遍历（搜索/导出/同步/统计/最近列表）都要排除 coordination 角色。maka 认了同样的代价。缓解靠查询收口，但新建旁路查询时仍会漏——列入 code review 检查项。
- **v1 单活委托约束太紧**：用户想让两个委托先后进同一会话排队时，第二个直接被拒（回澄清）。先紧后松是对的（并发委托的正确性论证复杂度陡增），松绑判据：内测期 `delegation_conflict` 拒绝码占比 >10% 才考虑队列化。
- **fail-closed 的体验反噬**：路由模型弱时用户每句话都被反问，比没有协调层更烦。E4（多余澄清率 ≤20%）就是卡这个的；接电前必须用真实消息分布测，不能用合成消息。
- **名词混淆**：普通会话里有 `delegate_task`（派给本会话任务槽），协调入口有「委托」（派给会话）。用户面两套文案必须可区分（槽任务叫「任务」，链上叫「委托给会话 X」），落 i18n 时统一。

## 待爸拍板

| # | 问题 | 类型（拍错了受伤的是什么） | 我的建议 |
|---|------|------------------------|---------|
| Q1 | 协调入口的产品形态：独立常驻面板（maka 的 WorkHub 浮窗形态）还是现有会话列表里一个隐藏角色 + 侧栏顶部固定入口按钮？ | **定位与边界**——拍错整个 renderer 信息架构返工，且用户「在哪找到协调」的心智一旦形成难改 | v1 做隐藏角色 + 侧栏顶部「协调」入口按钮，不做独立面板/浮窗；面板形态等内测数据再说 |
| Q2 | ~~路由不确定时的默认档：宁可 `clarify` 还是宁可 `answer_here`？~~（R1 撤销拍板需求）D4 已把一切失败路径锁死 fail-closed 到 `clarify`、无任何路径静默 create_new 或绑定会话——正文已定，本槽降级为确认记录 | —（不再是开放槽） | 维持 D4；若要改默认档，先改 D4 契约再回本表，不在此处开后门 |
| Q3 | 单活委托：同一目标会话已有 active 委托时，第二个委托 v1 是直接拒绝回澄清，还是排进目标会话队列？ | **业务规则**——系统行为错：排队会引入「用户以为派了其实还在等」的静默延迟，拒绝会打断「我就想让它连着干两件」的自然意图 | v1 直接拒绝并在澄清里带「已有委托在跑」上下文；内测看 `delegation_conflict` 占比再决定是否队列化 |
| Q4 | 路由模型用协调会话自己保存的模型（主模型兼任）还是独立小模型配置？ | **成本与性能**（涉付费 API 调用归爸）——R1 重估：成本大头在**输入**不在输出——意图调用吃用户文本 ≤2000 字 + 最近 8 条转录 ×600 字，召回再吃一遍用户文本 + ≤32 候选描述，两次调用合计**输入约 4-7k token/条消息**、输出仅 80/160，全走主模型时账单随消息量线性涨 | 仍默认用协调会话已保存的模型（零配置优先，非程序员配不动旋钮）；设置里留「路由专用模型」可选项（v1.1），flag 内测期用 E5 计时 + 账单数据回看是否值得切小模型 |
| Q5 | 协调会话的转录进不进遥测上传与上线后评分分母？ | **数据口径**——拍错要么系统会话污染上线评分（协调轮天然高频短轮），要么协调行为完全无观测 | 进遥测上传（`toSessionRow` 的 `session_type` 列带 coordination，`telemetryUploaderService.ts:409`），但**剔出评分分母**（现分母只剔 eval，`postLaunchScoreStore.ts:166`，需加剔 coordination） |
| Q6 | 计费/quota 归属：路由两次小调用记协调会话、被委托轮 token 记目标会话（现状记账按会话各自记）——协调侧要不要汇总「本委托总共花了多少」？ | **成本可见性**——拍错用户在目标会话看到一笔没来由的 token 消耗，或协调层为汇总重造一套记账 | v1 不做汇总投影（记账留各会话、委托卡片不带成本）；内测看用户是否追问再立单 |
| Q7 | companion（手机端）可见性：协调入口/委托卡片要不要出现在手机端？ | **产品边界**——companion 已能按会话渲染审批卡（`ApprovalCard @ packages/mobile/src/features/sessions/ApprovalCard.tsx:4`），委托轮触发审批时手机上只见目标会话的卡、看不到「这是委托来的」上下文 | v1 手机端不做协调入口（桌面先行）；目标会话审批卡照常可达（D5.2），委托上下文标注随 v1.1 |

## 拍板记录

> 只增不改。每条一行：日期 · 问题号 · 决定 · 决定人。

| 日期 | 问题 | 决定 | 决定人 |
|------|------|------|--------|
| 2026-09-23 | Q6 计费/quota 归属 | 同意 ADR 建议：v1 不做协调侧汇总投影，记账留各会话、委托卡片不带成本；内测看用户是否追问再立单 | 爸（林晨） |
| 2026-09-23 | Q7 companion 可见性 | 同意 ADR 建议：v1 手机端不做协调入口（桌面先行）；目标会话审批卡照常可达（D5.2），委托上下文标注随 v1.1 | 爸（林晨） |
| 2026-09-23 | Q1 / Q3 / Q4 / Q5 | 待对齐：爸要求配页面截图出图文 HTML 对齐后再拍 | — |

## 修订记录

| 日期 | 改动 | 原因 |
|------|------|------|
| 2026-09-23 | 初稿（只出 ADR 不施工） | N-WORKHUB-ADR |
| 2026-09-23 | R1：新增 D5.1 委托投递路径（queued_inputs 复用）与 D5.2 审批卡归属；接缝 (a) 改引真实主人（ADR-044，弃 bg 子代理账本误引）；候选集判据 `parent_session_id IS NULL` → `session_type='chat'` 白名单（不再误伤用户分叉）；准入门补 G10-G12、G2 扩全部非 native 引擎、G6 补用户直开会话；D5 链锚定（target_queued_input_id + 软链接降级 + fork 不跟链）与三种失效表；E1/E3/E4/E6 改写得出数的测法；拍板槽重整（Q2 撤销、Q4 补输入 token、新增 Q5-Q7）；锚点修正 RUN_STATUS_TRANSITIONS :17、goal 闸 :66 | 三席跨家审（claude/opus · kimi · grok）全票「修后可拍板」，7 条 Important 收敛（N-WORKHUB-ADR R1） |
| 2026-09-23 | R2：投递主人改记 `createWebQueuedInputDrain`（`registerDesktopQueuedInputDrain` 生产调用方 0）；E3 注入点②改为「paused_reason=restart 不自动补投」；`aborted(delivery_failed)` 可被同一 queued_input 行的重发翻回；委托必须带协调来源标记，编辑禁止、重排允许、投递时重跑 G1/G2/G10/G11/G12；删掉「ADR-067 防洗白」；终态投影改回 durable_runs，SQL 加回 `target_run_id`；G2 改为 `kind !== 'native'`；G12 评估异常即拒；G6/G10 改读 run registry；`hideProjectionSuffix` 锚点 :367→:359；建会话复用 `options.commit`。R1「前台轮无 durable_runs、故删 target_run_id、改挂 TaskManager」整段撤回，前提为假 | claude/opus R1 复审 3 条 Important + 3 条 Nit；本席在 8c7dde035 上逐条核过（N-WORKHUB-ADR R2） |
| 2026-09-23 | R3：G4 协议洞用持久态 `terminal_observed` 关上（投影到目标 run 终态时落表，幂等可重放；G4 只数 `active`；`aborted → active` 的复核加 G4）。D5.1 第 2、3 条与恢复语义的落点断言改成 INV-1～INV-6。`modelSpec` 排除出载荷指纹。新增「施工前置」，本 ADR 不定落点。E3 注入点改为「行被抢占前 / 行被抢占后、轮返回前」。R3 起 D5.1 只定不变量，落点由施工卡定 | claude/opus R2 复审。I1 采纳更小改法 (a)。I2–I4 与 N1–N4 不在 ADR 里定机制（N-WORKHUB-ADR R3） |

---

席位证据：GLM 5.3 · as-built 基线 origin/main@8c7dde035（本 worktree HEAD 同 commit，干净树核出）· maka 源料 commit d5bc0fad
R1（2026-09-23）：三席评审票存 `code-agent-private-archive/docs/evidence/assets/N-WORKHUB-ADR/review-{claude-opus,kimi,grok}-2026-09-23.*`；每条意见核到 8c7dde035 源码后再改，处置逐条记于证据档「R1 修订」节。
R2（2026-09-23）：Grok 4.7。R1 复审票核到 8c7dde035 后回改；处置与每条主人断言的生产调用方计数在证据档「R2 修订」节。
R3（2026-09-23）：Grok 4.7。I1 落 `terminal_observed`；I2–I4 收成不变量。处置在证据档「R3 修订」节。
