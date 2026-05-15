# code-agent 长任务通知产品化研究：对照 Memoh background task

日期：2026-05-14
范围：shell / build / test / browser / swarm / review / automation 等长任务的状态、日志、通知、失败原因和会话回带。
参考对象：复用 `/tmp/memoh-study`，重点读取 `internal/agent/background/manager.go` 与 `types.go`，再补读会话 wake / UI 转换链路。

核心判断：code-agent 已经有很多长任务能力，但它们各自成体系。shell/PTY 有 `taskId` 和 `outputFile`，DAG 有状态事件，swarm 有 run timeline，cron 有 execution history，review queue 有失败资产，session background 有系统通知。缺的是一个跨来源的任务契约和一个稳定产品面：用户离开当前 turn 以后，无法在同一个地方看到“还在跑什么、日志在哪、为什么失败、完成后怎么带回会话”。

Memoh 的价值不在于后台执行本身，而是把五件事串成闭环：`task id`、`output file`、stall detection、completion notification、agent wake / inject。code-agent 可以借这个闭环，但不应该替换现有 scheduler；更合理的是在现有 shell / DAG / swarm / cron / review 之上加一层轻量任务账本和通知契约。

## 1. code-agent 长任务来源清单和当前表现

| 来源 | 入口和关键文件 | 当前状态 / 日志 | 完成和失败如何可见 | 结果如何回到会话 | 主要缺口 |
| --- | --- | --- | --- | --- | --- |
| 前台 shell / build / test | `src/main/tools/modules/shell/bash.ts` | 前台命令通过 `tool_output_delta` 把 stdout / stderr 流进当前 turn。 | 当前 turn 内可见，失败随 tool result 返回。 | 留在 assistant/tool 消息和 trace 中。 | turn 结束后没有独立任务实体；长 build/test 一旦转后台，状态就散到另一套工具里。 |
| shell background task | `src/main/tools/shell/backgroundTasks.ts`、`taskOutput.ts`、`process.ts`、`bash.ts` | `startBackgroundTask()` 生成 `taskId`、写 `outputFile`，内存保留 1MB 输出，默认 10 分钟运行上限。`task_output` / `process_poll` / `process_log` 可查。 | 需要用户或 agent 主动轮询；完成 / 失败没有自动会话通知。进程重启后运行中任务被标成 failed。 | 返回启动消息里的 `<task-id>` 和 `<output-file>`；后续靠 `task_output` 手动拉回。 | 没有 stall detection；没有 terminal notification；没有统一 Inbox；没有“把结果带回当前会话”的产品动作。 |
| PTY session | `src/main/tools/shell/ptyExecutor.ts`、`process.ts`、`bash.ts` | `createPtySession()` 生成 `sessionId`、写 `outputFile`，支持 `process_write` / `process_submit` / `process_poll` / `process_log`。 | 退出状态存内存，可从 log 文件读尾部；无完成通知。 | 启动消息提示用户使用 process 工具继续交互。 | 交互等待和真正卡死无法区分；恢复后运行中 PTY 标成 failed；和 shell background 是两套 id 语义。 |
| Session background | `src/main/session/backgroundTaskManager.ts`、`src/renderer/components/features/background/BackgroundTaskPanel.tsx`、`src/shared/contract/sessionState.ts` | 以 `sessionId` 为任务 id，展示会话移入后台后的 running/completed/failed 和进度。右下角浮层可切回前台。 | `markCompleted()` / `markFailed()` 发送系统通知，并 3 秒后移除完成项。 | 点击浮层回到对应 session。 | 管的是“会话前后台”，不是 shell/PTY/DAG/swarm 任务；没有日志、output ref、失败资产，也没有和 tool task 接起来。 |
| DAG scheduler | `src/main/scheduler/TaskDAG.ts`、`DAGScheduler.ts`、`dagEventBridge.ts`、`src/shared/contract/taskDAG.ts` | DAG task 有 pending/ready/running/completed/failed/cancelled/skipped，DAG 有 progress/statistics。bridge 把节点、边、输出、失败转换成渲染进程事件。 | DAG 运行中可通过 `dag:event` 看节点状态。 | 主要是可视化和 DAG output passing；没有通用会话通知。 | `DAGScheduler` 是内存单例 currentDAG；内置执行器只有 agent/shell/checkpoint；shell executor 用 `execAsync`，没有 output file 和实时日志；cancel 标状态但不一定终止正在跑的 promise。 |
| subagent / active agent context | `src/main/agent/spawnGuard.ts`、`src/main/agent/activeAgentContext.ts`、`src/main/agent/runtime/contextAssembly/messageBuild.ts` | SpawnGuard 管理 agent id、status、promise、messageQueue、completion notification。`buildActiveAgentContext()` 把运行中 subagent 写进 system prompt。 | agent 完成后 `drainCompletionNotifications()` 把 `<subagent_notification>` 注入下一次模型上下文。 | 这是 code-agent 里最接近 Memoh inject 的机制。 | 只覆盖 subagent；UI 上没有统一任务卡 / Inbox；通知进 prompt，不等于用户明确看到日志、失败原因和 output ref。 |
| swarm / Agent Team | `src/main/agent/parallelAgentCoordinator.ts`、`swarmEventPublisher.ts`、`swarmTraceWriter.ts`、`src/main/ipc/swarm.ipc.ts`、`src/renderer/stores/swarmStore.ts` | 事件包含 launch requested/approved/rejected、started、agent updated/completed/failed、user message、completed/cancelled。renderer store 用 `sessionId` / `runId` 防串线，并生成 timeline。`SwarmTraceWriter` 持久化 run / agent / event。 | Agent Team 面板和 timeline 可见。失败存在 agent state/error 和 trace。 | `swarm:send-user-message` 会先持久化用户消息，再 fanout 给目标 agent；这是人手介入链路。 | swarm 是专门面板，未进入通用 TaskPanel / Inbox；完成后没有统一 conversation notification；run result 没有形成可被当前会话一键引用的 `TaskOutputRef`。 |
| review queue / Eval Center replay | `src/main/evaluation/reviewQueueService.ts`、`src/renderer/components/features/evalCenter/TurnTimeline.tsx` | `reviewQueueService` 用 SQLite 持久化 queue item 和 failure asset，身份链是 `session -> trace/replay key -> review item`。TurnTimeline 展示历史 turn、tool、assistant、token、compaction。 | Eval Center 可查看历史状态和失败资产。 | 用户通过 review/replay UI 回到 session 或复用证据。 | 它适合作为失败任务的 review sink，但不是长任务运行时 surface。实时任务状态、日志尾部、完成通知都不在这里。 |
| cron automation | `src/main/cron/cronService.ts`、`src/shared/contract/cron.ts`、`src/renderer/components/features/cron/*` | `CronJobExecution` 有 id/jobId/status/scheduledAt/startedAt/completedAt/duration/result/error/retryAttempt/exitCode。Cron Center 可看 job、stats、execution list/detail。 | execution detail 展示 result/error/exitCode。agent action 会创建 `[Cron]` session，shell action 用 `execAsync`。 | 结果留在 cron execution 和可能的 channel push；不回注原会话。 | 没有通用 task notification；shell output 没有独立 log ref；automation 完成后“带回当前会话”缺产品路径。 |
| heartbeat automation | `src/main/cron/heartbeatService.ts`、`src/shared/contract/cron.ts` | 周期 check 有 history/status，alert channel 支持 ipc / notification / webhook。 | 可用 system notification 和 IPC alert。 | 目前偏监控告警，不负责把结果注入某个当前会话。 | 应接入统一 `TaskNotification`，但 wake 规则必须更严。 |
| test / eval runner | `src/main/testing/testRunner.ts`、`autoTestHook.ts`、`src/main/evaluation/regression/*` | TestRunner 有 runId、case_start/case_end/suite_end/tool_result/error event，保存 JSON 到 resultsDir，并 best-effort 写 experiment DB。Regression runner 按 case 执行 `evalCommand`，有 timeout/stdout/stderr/exitCode。 | Eval Center 和报告文件能看结果；verbose 模式打 console。 | 通过 sessionId / replayKey / telemetry replay 连接到评测证据。 | event 没接到通用 UI task surface；长 run 没有统一日志、stall、完成通知；regression 并发 runner 只有最终 report。 |
| browser visual smoke | `src/main/agent/runtime/browser/visualSmoke.ts` | Playwright / system Chrome CDP 跑 desktop/mobile viewport 检查，返回 summary、failures、checks、diagnostics。 | 失败作为 tool / runtime 结果出现。 | 写进当前结果，不是后台任务。 | 本身有 timeout 和诊断，但没有作为长任务进入任务账本；浏览器启动卡住时用户只看到当前 turn 等待。 |
| live preview dev server | `src/main/services/infra/devServerManager.ts`、`src/main/ipc/livePreview.ipc.ts`、`src/renderer/components/LivePreview/DevServerLauncher.tsx` | DevServerManager 启动 child process，保存 sessionId/status/url/pid/startAt/log ring。Launcher 每 500ms 轮询日志，等待 ready 后打开 preview。 | 模态里显示 starting/ready/failed 和最近日志。 | ready 后打开 Live Preview tab。 | 只在启动模态里可见；没有统一 task id/output ref；ready/failed 后不进入 Timeline / Inbox；长期运行的 dev server 与 shell/PTY 任务分离。 |
| PreviewPanel export / artifact preview | `src/renderer/components/PreviewPanel.tsx` | 预览 markdown/code/image/pdf/csv/html，保存、刷新、长截图导出各自有 loading/error 状态。 | 面板局部显示错误。 | 产物通过 panel 查看。 | 这是 artifact surface，不是 task lifecycle surface；可以消费 `TaskOutputRef`，不该承担任务管理。 |

### 现状归纳

code-agent 的能力分布可以概括成三类：

1. 有 task id / output file，但缺通知：shell background、PTY。
2. 有运行状态 / timeline，但缺统一 output ref：DAG、swarm、cron、test runner、live preview。
3. 有产品入口，但只服务自己的域：BackgroundTaskPanel、Cron Center、Eval Center、PreviewPanel、Agent Team。

真正应该补的是跨来源的任务账本。它不调度任务，只记录任务；不替代 DAG，只订阅 DAG；不吞掉 swarm，只把 swarm run 映成 task；不改 review queue，只让失败任务能送进 review queue。

## 2. Memoh background task 机制拆解

Memoh 的 background manager 做了一个非常小但完整的任务闭环。

### 2.1 Task 和 Notification 契约

`/tmp/memoh-study/internal/agent/background/types.go` 定义了三层对象：

- `Task`：`ID / BotID / SessionID / Command / Description / WorkDir / Status / ExitCode / OutputFile / StartedAt / CompletedAt`，内部还保存 cancel、notified、stalledNotified、bounded output tail。
- `TaskSnapshot`：给 handler / UI 的锁安全视图，额外算 `Duration` 和 `Stalled`。
- `Notification`：给 agent 的结构化事件，包含 `TaskID / BotID / SessionID / Status / Command / ExitCode / OutputFile / OutputTail / Duration / Stalled`。

`Notification.FormatForAgent()` 会生成 `<task-notification>` 块，里面有 task id、status、command、exit code、duration、output file、output tail。stall 场景会把 status 写成 `stalled`，并附上“可能等待交互输入”的建议。

### 2.2 任务启动和日志

`manager.go` 的 `Spawn()` 做四件事：

- 生成 `bg_<bot-prefix>_<rand>` 风格 task id。
- 把 output file 固定到 `/tmp/memoh-bg/<taskID>.log`。
- 立刻 emit UI `started` event。
- goroutine 跑命令。

命令执行时用 shell wrapper 把输出 `tee` 到 log 文件，并把真实 exit code 写入 sentinel 文件：`<outputFile>.exit`。这样即使流异常，也可以读 sentinel 恢复真实退出码。

`SpawnAdopt()` 支持把已经在前台跑的 stream “交给后台”继续管理。这一点对 code-agent 很关键：长 build/test 一开始可能是前台，超过阈值后才需要转后台，不能杀掉重跑。

### 2.3 stall detection

Memoh 的 stall watchdog 每 5 秒检查一次输出增长，连续 45 秒没有新输出后检查 tail 是否像交互提示。匹配模式包括 `$`、`>`、`password:`、`y/n]`、`yes/no)`、`Press ... to continue`、`Continue?`、`Proceed?` 等。

检测到 stall 后：

- 标记 `stalledNotified`，保证只通知一次。
- emit UI `stalled` event。
- enqueue 一条 `Stalled=true` 的 notification。
- 任务仍保持 running，后续 terminal completion 还会再发一次 terminal notification。

这一点比单纯 timeout 更有产品价值。timeout 是“已经失败”，stall 是“现在需要人或 agent 处理”。

### 2.4 completion notification

`completeTask()` 统一处理 stdout/stderr/error/exitCode，设置 completed 或 failed，emit UI terminal event，并用 `MarkNotified()` 防重。随后 enqueue terminal notification，带 output tail 和 output file。

notification 是 manager 内存队列，按 `botID + sessionID` scope drain。它既服务 UI，也服务 agent wake。

### 2.5 agent wake / inject

`manager.go` 支持 `SetWakeFunc()`。每次 enqueue notification 时，如果 wake func 存在，就异步调用 `wakeFunc(botID, sessionID)`。

`/tmp/memoh-study/internal/conversation/flow/resolver_trigger.go` 的 `TriggerBackgroundNotification()` 做了安全边界：

- 先确认 session 有待处理 notification。
- 调 `tryEnterIdleSessionTurn()`。如果当前 session 正在 active turn，直接 defer，不抢正在跑的 turn。
- idle 时一次 drain 当前 session 所有 notification。
- 构造 query `[background notification]`。
- 把 notification message append 到 run config 的 messages，让第一次 LLM call 能看到。
- 正常走同一套 resolver / system prompt / tools / stream path。
- 如果 delivery context 或 stream 失败，会 `RequeueNotifications()`。
- 最后把 agent 生成的文字通过 outbound path 发给用户。

这条链的关键不是“后台自动跑模型”，而是“只在 idle、一次 drain、失败可重排、用普通会话路径交付”。

### 2.6 UI 显示和历史合并

Memoh 的 UI 层有 `UIBackgroundTask`，字段是 `task_id / status / command / output_file / exit_code / duration / output_tail / stream / chunk / stalled`。

转换链路做两件事：

- tool result 里如果有 `task_id` 和 `background_started / auto_backgrounded / started`，把 assistant tool message 标成 running background task。
- 持久化消息里如果出现 `<task-notification>`，解析成 `system` turn，`kind=background_task`，同时 merge 回原来的 tool message，让历史里的“启动任务”能被完成状态覆盖。

`ApplyBackgroundTaskSnapshots()` 还能把 live snapshot overlay 到已转换 UI turns 上，解决刷新页面后 persisted tool result 还是 running 的问题。

## 3. 对 code-agent 的产品方向

### 3.1 任务条

任务条放在聊天页轻量位置，只显示当前会话最重要的 1 到 3 个运行中任务：命令名、状态、耗时、最后一条日志尾部、一个展开入口。它服务“我刚让它跑的东西还在不在”，不承载完整管理。

适合进入任务条的任务：

- 当前 turn 启动的 shell/PTY/background task。
- 当前 session 的 swarm run。
- 当前 session 触发的 DAG / browser smoke / live preview startup。
- 当前 session 里明确关联的 test/eval run。

不适合塞任务条的任务：

- 已归档的 cron history。
- 其他 session 的后台任务。
- 纯 review queue item。

### 3.2 TaskPanel

TaskPanel 应该成为长任务的主 surface，位置沿现有 chat-native workbench 方向收进右侧深层 panel。它不替代 PreviewPanel、Eval Center、Cron Center、Agent Team，而是做聚合入口：

- Running：正在跑的任务，带日志 tail、耗时、kill/continue/poll。
- Attention：stalled、waiting input、approval required。
- Completed：完成摘要、output refs、把结果带回会话。
- Failed：失败原因、exit code、最近日志、送 review queue、重跑。

TaskPanel 需要按 `sessionId` 和 `source` 过滤。当前会话默认只看本 session，Inbox 再看跨 session。

### 3.3 会话通知

会话通知是聊天流里的 compact system card。它应该在 terminal 或 attention 场景出现：

- `build failed`：显示退出码、失败阶段、日志尾部、查看完整 log、加入 Review。
- `test completed`：显示通过率、失败 case 数、report ref、带回结果。
- `swarm completed`：显示 agent 完成/失败数、aggregation summary、打开 Agent Team run。
- `background task stalled`：显示可能等待的输入提示、kill、继续等待、用非交互 flag 重跑。

会话通知的重点是“用户看得见”，不等于自动让模型继续行动。

### 3.4 系统通知

系统通知只用于用户可能离开 app 的场景：

- 用户显式把会话移到后台。
- 长任务超过阈值后完成或失败。
- cron / heartbeat alert。
- app 不在前台时，当前 session 任务结束。

系统通知点击后打开对应 session + TaskPanel task，不直接触发 agent 执行。

### 3.5 Timeline 事件

TaskEvent 应该进入现有 Timeline，而不是再造一套时间线：

- turn trace 里记录当前 turn 启动的 task、output ref、terminal notification。
- swarm timeline 继续展示 swarm 细节，但 run 也映成一个 Task。
- Eval Center TurnTimeline 可以展示历史 TaskEvent，用于解释“这个报告来自哪次执行”。

`src/shared/contract/trace.ts` 现在的 toolCall 已经有 `outputPath / liveOutput / artifacts`，可以先接 `TaskOutputRef`，再逐步补 `task_event` 节点类型。

### 3.6 Inbox

Inbox 是跨 session、跨 automation 的未读完成/失败队列。它应该收：

- detached shell / PTY 完成。
- cron / heartbeat alert。
- swarm run 完成但用户不在该 session。
- review follow-up 生成完毕。
- build/test/eval 长跑完成。

Review Queue 只收“需要复盘和改进资产”的失败项，不承担所有任务通知。

## 4. 数据契约建议

建议先加 shared contract，不急着把所有运行器迁进去。第一版契约只做记录、展示和通知。

```ts
export type TaskKind =
  | 'shell'
  | 'pty'
  | 'dag'
  | 'swarm'
  | 'browser'
  | 'build'
  | 'test'
  | 'evaluation'
  | 'review'
  | 'cron'
  | 'heartbeat'
  | 'live_preview';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'orphaned';

export type TaskWakePolicy =
  | 'never'
  | 'notify_only'
  | 'inject_next_turn'
  | 'wake_once_when_idle';

export interface Task {
  id: string;
  kind: TaskKind;
  source: 'shell' | 'scheduler' | 'swarm' | 'cron' | 'review' | 'browser' | 'test' | 'session';
  title: string;
  status: TaskStatus;
  sessionId?: string;
  parentTurnId?: string;
  toolCallId?: string;
  runId?: string;
  command?: string;
  cwd?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  progress?: {
    current?: number;
    total?: number;
    percent?: number;
    label?: string;
  };
  failure?: {
    message: string;
    reason?: string;
    exitCode?: number;
    category?: 'timeout' | 'stalled' | 'command_failed' | 'agent_failed' | 'approval_rejected' | 'cancelled' | 'unknown';
  };
  outputRefs: TaskOutputRef[];
  notificationIds: string[];
  wakePolicy: TaskWakePolicy;
  wakeBudget: {
    terminal: number;
    stalled: number;
  };
  visibility: 'current_session' | 'workspace' | 'global';
  unread: boolean;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  sessionId?: string;
  parentTurnId?: string;
  type:
    | 'created'
    | 'started'
    | 'stdout'
    | 'stderr'
    | 'progress'
    | 'waiting_input'
    | 'stalled'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'output_ref'
    | 'notification_queued'
    | 'notification_delivered';
  ts: number;
  severity: 'debug' | 'info' | 'warning' | 'error';
  message?: string;
  chunk?: string;
  data?: Record<string, unknown>;
  outputRefId?: string;
}

export interface TaskOutputRef {
  id: string;
  taskId: string;
  kind: 'log' | 'artifact' | 'trace' | 'replay' | 'preview' | 'report' | 'session' | 'url';
  label: string;
  path?: string;
  url?: string;
  mime?: string;
  sizeBytes?: number;
  tail?: string;
  preview?: string;
  createdAt: number;
  retention?: 'ephemeral' | 'session' | 'workspace' | 'pinned';
}

export interface TaskNotification {
  id: string;
  taskId: string;
  sessionId?: string;
  channel: 'conversation' | 'system' | 'inbox' | 'timeline' | 'review_queue';
  status: 'queued' | 'delivered' | 'dismissed' | 'failed';
  title: string;
  summary: string;
  failureReason?: string;
  outputRefs: TaskOutputRef[];
  actions: Array<
    | 'open_log'
    | 'open_task'
    | 'bring_to_chat'
    | 'add_to_review_queue'
    | 'rerun'
    | 'kill'
    | 'continue_waiting'
  >;
  queuedAt: number;
  deliveredAt?: number;
  wakeDecision?: {
    policy: TaskWakePolicy;
    reason: string;
    usedBudget: number;
  };
}
```

### join key 规则

- `taskId`：所有来源的统一任务 id。shell 现有 `taskId`、PTY `sessionId`、swarm `runId` 都可以映射成 `Task.id`。
- `sessionId`：跨会话隔离的第一 join key，swarm 已经证明 timestamp 不够可靠。
- `parentTurnId` / `toolCallId`：把任务带回当前聊天流。
- `runId`：保留 swarm / eval / cron 原生 id。
- `outputRef.id`：PreviewPanel、Eval Center、log viewer 都消费 output ref，不直接猜路径。

## 5. agent 是否应该被 wake

### 可以 wake / inject 的场景

这些场景可以允许一次性 wake，前提是 `wakePolicy` 明确允许，并且 session 当前 idle：

- 用户明确说“后台跑完告诉我”“跑完继续整理结果”“完成后把结果带回来”。
- subagent / swarm 子任务完成，需要把结果汇总进同一 session。
- 长 build/test/eval 完成，只做只读总结，不自动改代码。
- shell / PTY stalled，需要提示“可能等输入”，并给 kill / continue / retry 建议。
- cron / heartbeat 是用户配置过的 thread wake 或 notification job，且 action 是只读汇报。
- review follow-up 生成完，需要把失败资产送进 Inbox 或当前会话通知。

推荐注入方式：

- active turn 内只排队，不抢占。
- idle 后一次 drain 同 session terminal / stalled notifications。
- 注入内容只包含结构化 notification、output tail、output refs。
- 模型醒来后默认只总结，不继续开新工具，除非用户原始任务明确要求继续下一步。

### 必须等用户的场景

这些场景只通知，不自动 wake 执行：

- 任何写代码、改文件、commit、push、deploy、删库、发外部消息、花钱调用外部服务。
- build/test 失败后要选择修复方向，尤其有多种产品判断路径。
- task output 可能包含 secret、个人信息、客户数据。
- stalled 需要输入密码、token、2FA、交互确认。
- swarm launch / plan approval，继续沿现有 approval 机制等用户点头。
- 同一个 task 已经 wake 过一次，后续仍失败或反复 stall。
- cron job 不是当前 thread 的显式 wake 类型。

### 防止无限自动唤醒

每个 Task 默认预算：

- terminal wake 最多 1 次。
- stalled wake 最多 1 次。
- log/output event 不触发 wake。
- wake 后产生的新后台任务默认 `wakePolicy=notify_only`，除非用户显式允许链式继续。
- notification delivery 必须幂等，`notification_queued` 和 `notification_delivered` 都落账。
- delivery 失败可以 requeue，但要有退避和最大重试。

## 6. 实现路线

### P0：统一看见，先不自动唤醒

用户价值最高，风险最低。

1. 加 `Task / TaskEvent / TaskNotification / TaskOutputRef` shared contract 和轻量 SQLite store。
2. 做 adapter，不替换执行器：
   - shell background / PTY：映射现有 `taskId/sessionId/outputFile/status`。
   - session background：映射现有 `BackgroundTaskInfo`。
   - swarm：把 `runId` 映成 task，swarm events 映成 TaskEvent。
   - DAG：订阅 dagEventBridge events 映成 TaskEvent。
   - cron / heartbeat：把 `CronJobExecution` 和 alert 映成 task/notification。
   - live preview：把 `DevServerSession` 映成 live_preview task。
3. TaskPanel 右侧聚合当前 session running/attention/completed/failed。
4. 会话里加 terminal notification card，但只做 UI 展示和 actions，不自动调用模型。
5. Output refs 打通：
   - shell/PTY output file。
   - swarm trace run。
   - test report / replayKey。
   - cron execution result。
   - live preview URL / logs。
6. 失败原因归一：exit code、timeout、stalled、agent failed、approval rejected、cancelled。
7. “加入 Review”动作只对 failed / partial / reviewable task 开启，复用 `reviewQueueService`。

P0 验收口径：

- 跑一个后台 shell，TaskPanel 可见 running，完成后同会话出现通知，能打开 log。
- 跑一个 PTY 长任务，能 poll/log/kill，TaskPanel 状态同步。
- 跑一个 swarm，Agent Team 和 TaskPanel 都能看到同一 run，不串 session。
- 触发一个 cron shell execution，Cron Center 和 Inbox 都能看到同一结果。

### P1：wake / inject 一次，补 stall detection

用户价值高，但需要安全边界。

1. 给 shell background / PTY 增加 stall detector：
   - 无输出增长阈值。
   - tail 交互提示识别。
   - status 标成 `stalled`，不直接 kill。
2. 引入 notification drain：
   - 按 `sessionId` drain。
   - active turn defer。
   - idle 才允许 `wake_once_when_idle`。
3. 复用 code-agent 现有 `activeAgentContext` 思路，但把 notification 分成两层：
   - UI notification：用户一定看得到。
   - model injection：只有 wakePolicy 允许时进入下一次 model message。
4. Timeline 接入：
   - turn trace 增加 TaskEvent / TaskOutputRef。
   - Eval Center TurnTimeline 读历史 TaskEvent。
5. “带回当前会话”动作：
   - 把 output tail / summary / output refs 插入 composer 或作为 system/background turn。
   - 不自动改文件。

P1 验收口径：

- 后台命令出现交互提示后，45 到 60 秒内出现 stalled notification。
- 当前 session active turn 时 notification 不抢占，turn 完成后再显示。
- 用户显式授权的“跑完继续总结”只 wake 一次。
- wake 失败后 notification 不丢，Inbox 仍可见。

### P2：跨工作区 Inbox、retention、深度产品化

用户价值中高，依赖 P0/P1 稳定。

1. Workspace Task Inbox：
   - unread / archived / source / status 过滤。
   - 跨 session 跳转。
   - 批量 dismiss。
2. 系统通知策略：
   - app inactive、长任务阈值、automation alert。
   - 点击打开 session + task。
3. log retention：
   - ephemeral / session / workspace / pinned。
   - 大日志 tail + 文件引用，不把全文塞 DB。
4. browser/build/test 更细 instrumentation：
   - dev server ready/stopped/failed/stalled。
   - test runner suite/case progress。
   - visual smoke viewport progress。
5. automation handoff：
   - cron/heartbeat 结果可选回写到原 thread。
   - 只读总结和需人工确认的 action 分开。
6. 学习闭环：
   - failed task 一键生成 review queue item。
   - 失败分类进入 eval / regression assets。

## 7. 推荐落点

第一步不要从“自动唤醒模型”开始。最稳的 P0 是让用户先看见所有长任务，并且能打开日志、理解失败、把结果带回当前会话。

推荐第一版产品形态：

- 当前聊天页：轻任务条 + terminal notification card。
- 右侧 TaskPanel：全量任务聚合和 action。
- Inbox：跨 session 未读完成/失败。
- Timeline：只做历史解释，不承担实时管理。
- PreviewPanel：继续做 output ref 的展示器。
- Review Queue：继续做失败复盘和能力改进入口。

Memoh 的 wake/inject 适合做 P1：它证明了“idle 后一次 drain notification，再用正常会话路径交付”这条路可行。但 code-agent 的边界要更严，因为这里会涉及文件修改、提交、部署、外部 automation 和多 agent 编排。默认策略应是通知优先，wake 需要显式授权或明确原任务语义。

## 8. 2026-05-14 P0 落地追踪

本轮先把 P0 压在 shell / PTY 两条最确定的长任务来源上，目标是让用户在一个地方看到状态、日志引用和终态提醒，不触碰现有 scheduler，也不引入自动 wake。

已落地的最小链路：

- 新增 `src/shared/contract/backgroundTask.ts`，定义 `Task / TaskEvent / TaskNotification / TaskOutputRef`，状态覆盖 `running / waiting_input / stalled / completed / failed / cancelled / expired / orphaned`。
- 新增 `src/main/tasks/backgroundTaskLedger.ts`，提供内存 ledger、输出引用、通知队列、按 session drain，并对稳定 notification id 做幂等保护。
- 新增 `src/main/tasks/backgroundTaskSnapshotAdapters.ts`，把 `shell:${taskId}` 和 `pty:${sessionId}` 映射成统一 Task，保留 command、cwd、sessionId、toolCallId、duration、exitCode、log output ref。
- `backgroundTasks.ts` / `ptyExecutor.ts` 增加 started / completed / failed lifecycle event，`backgroundTaskSnapshotAdapters.ts` 安装事件桥接；snapshot list 仍保留为刷新兜底。
- `bash` 工具在启动后台 shell / PTY 时透传 `ctx.sessionId` 和 `ctx.currentToolCallId`，让终态通知可以回到正确会话。
- 新增 `domain:backgroundTasks` IPC，renderer 可以 list task、get task、drain notification。
- renderer 新增 `backgroundTaskStore` 和 `useBackgroundTaskSync`，App 挂载后周期同步任务；当前会话 drain 到 terminal notification 时，用 toast 告知用户，并指向 TaskPanel 查看日志。
- `useRunWorkbenchModel` 把 ledger task 转成现有 `TaskRecord`，复用 TaskPanel 的任务列表；任务条和系统通知点击都打开右侧 Task tab。
- `Notification.on()` 不再丢弃 click listener，平台层可以保留并触发回调；但当前 macOS `osascript display notification` 仍不是可靠 click provider，真实系统通知点击需要后续换原生 notifier / Tauri notification API。

这版刻意没有做三件事：

- 没有替换 `TaskDAG / DAGScheduler / swarm / cron / heartbeat` 的运行模型。
- 没有把 notification 自动注入模型上下文，也没有后台无限唤醒 agent。
- 没有把所有任务源一次性接进 Inbox；shell/PTY 只是 P0 验证面。

验证结果：

- `/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/tasks/backgroundTaskLedger.test.ts tests/unit/tasks/backgroundTaskSnapshotAdapters.test.ts`：2 个 test file、7 个测试通过。
- `/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false`：通过。
- 主进程模块层 smoke：实际启动 `printf event-smoke` 后台 shell，不调用 snapshot sync，靠 lifecycle event 同步到 ledger；状态为 `completed`，带 `log` output ref，并能按 `event-smoke-session` drain 到 `task_completed` notification。
- GUI smoke：重新 build `dist/web/webServer.cjs` 和 `dist/renderer`，启动 app-host，用 Playwright + system Chrome 打开真实页面；`/api/health` 正常，chat input 可见，TaskPanel 可见，无 console/page error。

剩余 P0 风险：

- 当前通知是 renderer 轮询后 toast；系统通知 click handler 已不再 no-op，但 macOS `osascript` 仍不能可靠承诺 OS 级点击回跳。
- shell/PTY terminal 同步已经是 lifecycle event 驱动；snapshot adapter 仍保留为 list/get 的恢复和刷新兜底。
- 还没有 stall detector，等待输入和真正卡死仍无法区分，这属于 P1。
