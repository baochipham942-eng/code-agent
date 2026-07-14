# 数据存储架构

> SQLite + Supabase + pgvector

## 本地存储 (SQLite)

**位置**: `app.getPath('userData')/code-agent.db`

本地数据库由 `src/host/services/core/databaseService.ts` 初始化，路径来自平台层 `app.getPath('userData')`，不是旧文档里的 `~/.code-agent/data.db`。初始化已拆成四类职责：

| 模块 | 职责 |
|------|------|
| `src/host/services/core/database/schema.ts` | 主 schema 与幂等列迁移 |
| `src/host/services/core/database/indexes.ts` | sessions、messages、telemetry、snapshot、checkpoint 等索引 |
| `src/host/services/core/database/migrations/*` | 专项迁移和历史兼容 |
| `src/host/services/core/database/nativeLoader.ts` | better-sqlite3 native binding 加载 |

```sql
-- sessions 表
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  generation_id TEXT NOT NULL,
  working_directory TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- messages 表
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,     -- JSON
  tool_results TEXT,   -- JSON
  timestamp INTEGER,
  is_meta INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'active',
  hidden_by_rewind_id TEXT,
  hidden_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

上面的 SQL 是最小会话模型。2026-04-27 之后，真实本地库已经把 agent runtime 的恢复面也纳入 SQLite，不再只持久化 sessions/messages。

### 2026-04-27 runtime durable state

| 表 / 字段 | 用途 | 主要写入路径 |
|-----------|------|--------------|
| `sessions.status` | session 级运行终态，支持 `idle/running/paused/interrupted/orphaned` 等状态 | `SessionRepository` / `TaskManager` |
| `sessions.workbench_provenance` | Workbench 能力选择、direct routing、session-backed reuse 的会话级投影 | `lightMemory/sessionMetadata.ts` / workbench provenance |
| `messages.metadata` | user message 的 `metadata.workbench`、direct routing delivery 等消息级上下文 | `SessionRepository.addMessage()` |
| `messages.is_meta` | 后台自动化和内部运行轮次标记；普通会话列表、FTS、同步和 summary 默认过滤 | `SessionRepository.addMessage()`、`LoopController` meta turns |
| `messages.compaction` | manual compact / autocompact 的 compaction survivor 信息 | `contextHealth.ipc.ts` / `contextAssembly/compression.ts` |
| `todos` | auto todo 与 finalizer 消费的 session-scoped todo 状态 | `src/host/agent/todoParser.ts` |
| `session_tasks` | Task tool / planning taskStore 的 durable task graph；`parent_task_id` 保留树状任务父子关系，runtime state 恢复时能还原 owner / blocks / parent link | `src/host/services/planning/taskStore.ts`、`SessionRepository` |
| `context_interventions` | pin / exclude / retain 等手动上下文干预，按 session + agent 持久化 | `src/host/context/contextInterventionState.ts` |
| `session_runtime_state` | `compression_state_json` 与 `persistent_system_context_json`，供 reload 后恢复 ContextAssembly 状态 | `src/host/agent/runtime/runtimeStatePersistence.ts` |
| `pending_approvals.kind` | plan approval 与 swarm launch approval 共用表但按 kind hydrate/orphan，避免互相抢状态 | `PendingApprovalRepository` |
| `permission_decisions` | 工具权限 allow / deny / ask 的 append-only 决策账本，供后续审计权限链路 | `ToolExecutor` / `DatabaseService.appendPermissionDecision()` |
| `tool_execution_events` | 工具执行 begin / complete 生命周期账本，重启后可定位崩溃时未闭合的工具调用 | `ToolExecutor` / `DatabaseService.appendToolExecutionBegin/Complete()` |
| `session_task_events` | task / todo 的 append-only 事件 lane，给统一会话 replay 提供任务变化事实 | `todoWrite` / task runtime |
| `swarm_run_ledger` | Swarm run 的 append-only lifecycle 真理源；只有带 `run_closed` 的 run 才作为最终 rollup 事实 | `SwarmLedgerRepository` / `SwarmTraceWriter` |
| `swarm_runs / swarm_run_agents / swarm_run_events` | Agent Team run、agent rollup 与 timeline 展示缓存；不再是 Swarm 聚合事实的唯一来源 | `SwarmTraceWriter` / `SwarmTraceRepository` |
| `artifact_issues / artifact_issue_evidence` | 生成物质量问题、证据引用、admin review 决策 | `ArtifactIssueRepository` |
| `eval_replay_quality_reports` | replay/eval 的产品级质量报告与 release gate 状态 | `ArtifactIssueRepository` / `ExperimentAdapter` |
| ~~`review_queue_items.delivery_review`~~ | 已下线；旧 Delivery Review 不再写 review queue | 5/19 evaluation cleanup |
| ~~`preview_feedback_items`~~ | 已下线；Workspace Preview 不再维护旧 Preview Feedback 侧栏 | 5/19 evaluation cleanup |
| `telemetry_sessions / telemetry_turns / telemetry_model_calls / telemetry_tool_calls / telemetry_events` | structured replay 与 eval completeness gate 的事实来源 | `TelemetryCollector` / `TelemetryStorage` |
| `turn_snapshots / compaction_snapshots` | 调试快照与压缩前后诊断，支持 CLI debug 和 settings retention | `turnSnapshotWriter` / `compactionSnapshotWriter` |

当前边界：unit 级恢复链已经覆盖 todos、session_tasks、context interventions、runtime state、pending approvals、structured replay；完整 app restart / reload smoke 仍按对应计划文档里的延后风险处理。

### 2026-06-17 append-only event ledger durable state

这轮把权限、工具执行和 Swarm 聚合从“只看当前投影”推进到 append-only 事件账本。SQLite 仍是本地事实层，表级边界如下：

| 表 / 字段 | 用途 | 主要不变量 |
|-----------|------|------------|
| `permission_decisions` | 记录工具权限链路的最终决策、历史决策、原因、耗时和 trace JSON | 写入失败 fail-safe，不改变本次权限结果；按 `(session_id, recorded_at)` 与 `(tool_name, recorded_at)` 查询 |
| `tool_execution_events` | 用同一个 `execution_id` 串起 begin / complete，complete 记录 status / error | 允许重启后看到只有 begin 没 complete 的调用；不依赖 renderer 状态判断工具是否中断 |
| `session_task_events` | task / todo 的 append-only lane，供统一 replay 按时间还原任务变化 | 不替代 `session_tasks` 当前态，只补充审计与回放事实 |
| `swarm_run_ledger` | 只追加 `run_started`、`agent_snapshot`、`run_closed`；`(run_id, seq)` 唯一 | 只有含 `run_closed` 的 ledger 才能覆盖 rollup；半套账本视为运行中或崩溃现场 |
| `swarm_runs / swarm_run_agents / swarm_run_events` | Swarm trace 读缓存和 UI timeline；`swarm_run_events` 仍受 `MAX_EVENTS_PER_RUN=2000` 控制 | rollup 可以由完整 ledger 重建；timeline 事件不是关键聚合事实源 |

对账和迁移边界：

- `swarmReconcileService` 默认只读扫描，用 ledger 重建值和 rollup 表对比。
- 写回 rollup 需要显式传入 `rebuildOnDrift` 和 writer，避免后台扫描偷偷改库。
- 老 run 不在 app 启动时自动迁移；`backfillSwarmLedger` 是 opt-in、事务内执行、幂等跳过已有 ledger 的 run。
- JSONL / SQLite 双后端仍服务 trace 读取场景；新的 `swarm_run_ledger` 是 SQLite 本地真理源，历史 JSONL run 继续按原 trace 路径读取。

### 2026-05-11 prompt rewind durable state

Prompt Rewind 使用"隐藏旧尝试，保留审计"的存储模型。普通会话读取只看到 active transcript；被回退的消息仍在本地和云端保留，供同步、审计、搜索显式 include 和 replay 查询使用。

| 表 / 字段 | 用途 | 主要写入路径 |
|-----------|------|--------------|
| `messages.visibility` | `active` / `rewound`，所有普通消息读取、计数、session 列表默认只看 active | `SessionRepository.applyPromptRewind()` |
| `messages.hidden_by_rewind_id` | 标记消息被哪次 rewind 隐藏，方便审计和回放归因 | `SessionRepository.applyPromptRewind()` |
| `messages.hidden_at` | 隐藏时间戳，支持后续按时间排序和同步冲突排查 | `SessionRepository.applyPromptRewind()` |
| `session_rewinds` | 每次 rewind 的审计记录：anchor message/prompt/timestamp、checkpoint message、hidden ids、files restored/deleted、errors | `SessionRepository.applyPromptRewind()` |
| `file_checkpoints` | 文件恢复的事实来源；rewind 时选取 anchor timestamp 之后第一条 checkpoint，再调用 `rewindFiles()` | `FileCheckpointService.getFirstCheckpointAtOrAfter()` |
| `session_messages_fts` | 默认搜索 join `messages` 并过滤 rewound；显式 `includeRewound` 时才查完整历史 | `SessionRepository.searchSessionMessagesFts()` |

本地 SQLite schema 在 `src/host/services/core/database/schema.ts` 里幂等迁移；云端 Supabase 迁移是 `supabase/migrations/20260511000000_prompt_rewind.sql`，同步增加 `public.messages.visibility / hidden_by_rewind_id / hidden_at` 和 `public.session_rewinds`，并对 `session_rewinds` 开启 RLS。

### 2026-05-15~17 Agent Neo 管理与外部 engine 状态

这轮新增的状态分成三类：本地 session engine 元数据、主进程内 task ledger，以及 Supabase 管理面。外部 Agent Engine 的具体日志文件留在本地文件系统，SQLite 只保存 session 上的 engine metadata，不把 CLI 原始 jsonl 全量塞进 messages。

| 存储 / 字段 | 用途 | 主要路径 |
|-------------|------|----------|
| `sessions.agent_engine` | 保存当前 session 选择的 engine：`native / codex_cli / claude_code`、外部 engine model、permission profile、cwd、run/log 外部引用 | `src/shared/contract/agentEngine.ts`、`SessionRepository` |
| `config.json.models.agentEngines` | 保存本机对 Codex / Claude 外部 engine 的默认模型偏好；真实可选模型仍以签名 control-plane catalog 为准 | `src/shared/contract/settings.ts`、`ModelSettings.tsx` |
| 外部 engine log path | Codex / Claude 执行的原始流与输出引用，作为 task output ref 回到 TaskPanel | `codexCliAdapter.ts`、`claudeCodeAdapter.ts` |
| `BackgroundTaskLedger` 内存账本 | shell/background task、PTY、外部 engine 的 `Task / TaskEvent / TaskNotification / TaskOutputRef` 统一视图；按 session drain 通知 | `src/host/task/backgroundTaskLedger.ts`、`backgroundTaskLedger.ipc.ts` |
| 记忆条目运行态 | 导入候选、条目 CRUD、注入 trace 与 seed memory 注入，不再只靠 Light Memory 文件树裸展示 | `src/host/memory/memoryEntryRuntime.ts`、`memoryInjectionTrace.ts`、`seedMemoryInjector.ts` |
| Capability draft 文件 | MCP template 安装先写项目 `.code-agent/mcp.json` disabled draft；draft 带 `capabilityDraft` 元数据，删除时只移除自己生成的草稿 | `capabilityCenterService.ts`、`capabilityDraftResolver.ts` |
| `public.profiles.status / signup_source / invite_code / last_active_at` | 管理员用户 dashboard 的用户状态、来源和活跃信息 | `supabase/migrations/20260516000000_user_invite_management.sql` |
| `public.invite_codes` 扩展字段 | label、created_by、updated_at、last_used_at，支持 invite code 管理页 | `supabase/migrations/20260516000000_user_invite_management.sql` |
| Admin RPC | `admin_list_users / admin_list_invite_codes / admin_create_invite_code / admin_update_invite_code`，所有函数先走 `require_code_agent_admin()` | `adminService.ts`、`admin.ipc.ts` |
| Supabase explicit grants | 给 public schema 的现有和未来表/序列/函数补显式 grant，防止 Supabase Data API 默认权限改版后返回 42501 | `supabase/migrations/20260515000000_explicit_grants.sql` |

### 2026-06-12 Admin role RPC and shared relay operations

Admin 用户管理面现在覆盖两类授权：一类是团队共享 provider relay entitlement，一类是管理员角色本身。

| 存储 / RPC | 用途 | 主要路径 |
|-------------|------|----------|
| `control_plane_entitlements.capabilities` | `shared_relay` 能力授权；开启时补齐基础功能能力，关闭时只移除 `shared_relay`，保留基础能力 | `adminService.setUserSharedRelay()`、`UserDashboardSettings.tsx` |
| `public.admin_set_user_admin(p_user_id, p_is_admin)` | `SECURITY DEFINER` RPC，先调用 `require_code_agent_admin()`，再更新或创建 `profiles.is_admin` | `supabase/migrations/20260611000000_admin_set_user_admin.sql` |
| `AdminSchemas.SET_USER_ADMIN` | IPC payload 只接受 `{ userId: string, enabled: boolean }`，非法 payload 在 service 前被拒绝 | `src/shared/ipc/schemas/admin.ts`、`admin.ipc.ts` |

保护边界：用户不能通过该 RPC 撤销自己的 admin 角色；客户端不直接写 `profiles`，实际权限变更由 Supabase RPC 执行，避免绕过 RLS 或本地 UI 状态。

### 2026-06-12 transcript FTS and dream memory

本地库新增 transcript 级 FTS5 索引，用于查完整运行轨迹，而不是只查用户可见消息。它与普通 `session_messages_fts` 并存：

| 表 / 索引 | 用途 | 主要路径 |
|-----------|------|----------|
| `transcript_fts` | 按 kind 索引工具输入/输出、用户文本、assistant 文本和 reasoning，给 History 工具、dream consolidation 和调试回查使用 | `src/shared/transcriptFts.sql.ts`、`transcriptHistoryService.ts` |
| Memory BM25 | 本地 memory packing 的 FTS/BM25 召回通道，补充原有最近窗口和 token scoring | `MemoryRepository.ts` |
| Dream schedule | 周期性 dream consolidation 以 transcript 轨迹为 source-of-truth，先验证再写记忆 | `dreamMemoryService.ts`、`dreamScheduler.ts` |

### 2026-05-22 Web persistence health

Web standalone 模式会在启动时初始化同一套 SQLite database service。初始化成功时，`/api/health` 的 `persistence` 字段返回 `status:"available"`、`mode:"database"`、`durable:true`；失败时返回 `status:"unavailable"`、`mode:"memory"`、`durable:false` 和失败原因。UI 只在 `durable=false` 时提示“历史未持久化”。

| 字段 | 含义 |
|------|------|
| `status` | database 初始化是否可用 |
| `mode` | 当前写入目标，`database` 或 `memory` |
| `durable` | session 是否能跨 webServer 重启恢复 |
| `message` | 给用户看的短提示 |
| `reason` | 初始化失败的技术原因，只在不可用时返回 |

验收链以 `scripts/acceptance/session-persistence-smoke.ts` 为准：启动 webServer、创建 session、重启同一 `CODE_AGENT_DATA_DIR` 下的 webServer，再读取 session 列表确认刚创建的 session 仍存在。

### 2026-05 artifact verification durable state

这段是上一代交付验收数据面的历史口径。对应 service 已不再作为当前产品级质量 gate；`scenarioAcceptance` / `AcceptanceRunner` 已删除，当前产品级状态进入 2026-06 的 `ArtifactIssue` 数据面。

| 存储 | 用途 | 主要路径 |
|------|------|----------|
| ~~`preview_feedback_items`~~ | 旧 Preview Feedback 表，5/19 下线并由 cleanup migration drop | 已删除 |
| ~~`review_queue_items.delivery_review`~~ | 旧 Delivery Review metadata，5/19 下线并由 cleanup migration drop | 已删除 |
| Canonical eval run | SWE-bench 等外部评测结果转换成 `CanonicalEvalRun` 后进入产品 Experiment DB | `benchmarks/swe-bench/persistence.ts`、`src/host/evaluation/experimentAdapter.ts` |
| Evidence graph DB | Evidence → Proposal → Rule 的实验关系图，当前独立 SQLite，默认路径仍是 `~/.claude/evidence-graph.db` | `src/host/evaluation/evidence/evidenceDb.ts`、`schema.ts` |

后续 artifact verifier 的持久化走 `artifact_issues` / `artifact_issue_evidence`，不复用旧 evaluation review queue 表。audit 计划和 handoff 文档只作为过程材料，不进入普通会话 transcript。

### 2026-05-29 dynamic-workflow journal durable state

命令式 `workflow` 脚本运行时（见 [dynamic-workflow.md](./dynamic-workflow.md)）的 resumable 靠**源码重放 + 逐 `agent()` 调用结果缓存**，不序列化 VM 状态。专用两表，**不 FK 到 sessions**——journal 独立于会话生命周期（会话删了仍可 resume / 审计）。

| 表 / 字段 | 用途 | 主要写入路径 |
|-----------|------|--------------|
| `workflow_runs` | 一行/run 的元数据 + 终态：`run_id`(PK)、`script_hash`、`goal`、`session_id`、`status`、`started_at`、`finished_at`、`tokens_spent`、`result_json`、`error` | `WorkflowJournalRepository.start/finish()` |
| `workflow_run_calls` | 逐 `agent()` 调用的结果缓存（**仅成功调用**）：`(run_id, call_index)` 复合主键 + `content_hash`、`status`、`label`、`result_json`、`tokens_used`、`ts`；`run_id` FK 级联删 | `WorkflowJournalRepository.recordCall()` |

缓存键 = 位置序 `call_index` + prompt/语义 opts 内容 `content_hash`（排除 label/phase 显示字段）。`resumeFromRunId` 显式入参时载旧 run 缓存，同 index+hash 命中则瞬时返回（0 token / 不占并发闸 / 不耗 budget）。schema 在 `src/host/services/core/database/schema.ts` 幂等迁移；`getWorkflowJournalRepository()` 在 DB 未就绪时返 null 优雅降级。

### 2026-06 product closure quality durable state

Agent Neo 产品闭环把质量数据面收成三张表：

| 表 / 字段 | 用途 | 主要写入路径 |
|-----------|------|--------------|
| `artifact_issues` | 生成物或 eval/replay 暴露的质量问题：`issue_id`、artifact 信息、`UnifiedTraceIdentity`、source/code/severity/status、owner、repair instruction、decision trace、admin review、related issue ids | `ArtifactIssueRepository.upsertIssue()`、`ExperimentAdapter`、`/api/admin/review-queue/issues` |
| `artifact_issue_evidence` | issue 的证据引用：kind、ref、summary、data source、sensitivity、created_at，随 issue 级联删除 | `ArtifactIssueRepository.upsertIssue()` |
| `eval_replay_quality_reports` | replay/eval 质量报告：trace identity、status、run/case id、完整 report JSON、created/updated 时间 | `ArtifactIssueRepository.upsertQualityReport()` |

Admin review queue 不再是单独表，而是 `artifact_issues` 的派生视图：`listAdminReviewQueueItems()` 根据 severity、status、source 和 `admin_review_json` 计算 pending / approved / rejected。

### 2026-06 session owner scope

`sessions.user_id` 现在是本地读取边界的一部分。`SessionRepository` 的 list/get/update/delete/message 查询都可传 `userId`；`SessionManager` 默认使用当前 auth user，未登录时只看 `user_id IS NULL`。Web 返回 session 前会剥离 `modelConfig.apiKey`，避免本机 key 通过 JSON 响应泄露给客户端。

### 2026-06-05 role drafts and loop meta state

对话式角色创建/修改和 `/loop` 后台化新增两类本地状态：一类是文件系统里的角色草稿，一类是 SQLite 里的 meta message 标记。

| 存储 / 字段 | 用途 | 主要路径 |
|-------------|------|----------|
| `~/.code-agent/role-drafts/<draftId>/draft.json` | 待确认角色草稿元数据：roleId、description、category、tools、sessionId、createdAt、editingRoleId | `src/host/services/roleAssets/roleDraftQueue.ts` |
| `~/.code-agent/role-drafts/<draftId>/agent.md` | 模型起草出的完整 agent 定义。草稿目录不被 `agentRegistry` 扫描 | `generateRoleAgentMd()` |
| `~/.code-agent/agents/<roleId>.md` | 用户确认后写入正式角色定义；新建模式拒绝覆盖同名，修改模式允许覆盖同名定义 | `confirmRoleDraft()` |
| `~/.code-agent/roles/<roleId>/` | 角色记忆和履历资产目录；确认新角色时初始化，修改已有角色时保持幂等不清空 | `ensureRoleAssetDirs()` |
| `messages.is_meta` | loop 内部自动化轮次、runtime diagnostics 等不应进入用户可见 transcript 的消息标记 | `LoopController`、`EventBatcher`、`SessionRepository` |
| `session_messages_fts` trigger 过滤 | insert/update 时跳过 `is_meta=1`、`【循环模式 · 第%轮】` 和 `[[LOOP_WAIT]]` 内容，并清理旧脏索引 | `src/host/services/core/database/schema.ts` |

读取边界：

- 普通 session list/count/search/sync 使用 `visibleHistoryMessageWhere()`，过滤 rewound、meta 和 loop marker。
- 显式调试或 replay 若需要看内部轮次，需要走专门路径，不应复用普通会话列表的 count。
- 角色草稿被确认前不进入 `agents/`，因此不会被 `agentRegistry` 当成可调用角色。

### 2026-07-14 启动期 DB 维护提速（PR #374/#376）

DB init 曾在 1.28GB 生产库上每次启动静默吃 ~6s，三处根因全部修复，并留了分步计时日志（`[DatabaseService] init timings:`，回归时直接从用户日志定位慢步骤）：

| 改动 | 语义 | 主要路径 |
|------|------|----------|
| stale-FTS 清理 DELETE 加一次性门 | `PRAGMA user_version < 1` 才跑（全表扫 messages.content 的历史补救），跑完置 1。桌面 `schema.ts` 与 CLI `cliDatabaseSchema.ts` 共享同一 DB、同一门。**⚠️ 未来 FTS trigger 过滤条件再变，必须把门的版本号 bump（1→2）并同步两侧**，否则存量库不会重清 | `schema.ts`、`cliDatabaseSchema.ts`、`schemaFtsCleanupGate.test.ts` |
| `tool_execution_events` 复合索引 | `(execution_id, phase)` 替换单列 `execution_id` 索引（前缀覆盖）；缺它时 planner 对 `getOpenExecutions` 的 NOT EXISTS 反连接选 phase 索引，begin×complete 全交叉 | `schema.ts` |
| FTS backfill 守卫改存在性检查 | FTS5 虚表的 `COUNT(*)` 是全索引扫描；守卫一律 `SELECT 1 ... LIMIT 1`（桌面 2 处 + CLI 3 处），新增守卫沿用此口径 | `SessionRepository`、`MemoryRepository`、`cliDatabaseSchema.ts` |
| ShellEnvironment 磁盘缓存 | `<数据目录>/cache/shell-environment.json`（schema/platform/shell 三校验、0600、原子 rename）；命中即恢复 PATH + 后台刷新，未命中保持同步捕获 | `shellEnvironment.ts` |

## 云端存储 (Supabase)

**表结构**:

| 表名 | 用途 | 同步策略 |
|------|------|----------|
| `profiles` | 用户资料 | 单向云端 |
| `devices` | 设备管理 | 双向 |
| `sessions` | 会话记录 | 增量同步 |
| `messages` | 对话消息 | 增量同步 |
| `user_preferences` | 用户偏好 | Last-Write-Wins |
| `vector_documents` | 向量存储 | 仅上传 |

## 向量数据库

**扩展**: pgvector (Supabase 原生支持)
**维度**: 1024 (DeepSeek embedding)
**索引**: HNSW (cosine 距离)
**用途**: 语义搜索、长期记忆、RAG 上下文

---

## 数据分层架构 (5 Levels)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          数据分层架构 (5 Levels)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Level 4 ─── 跨设备数据 (Supabase cloud)                                    │
│  │           └── 会话历史、消息内容、用户资料                                │
│  │                                                                          │
│  Level 3 ─── 云端同步 (Supabase + Keychain)                                 │
│  │           └── 登录状态、认证 token、用户偏好                              │
│  │                                                                          │
│  Level 2 ─── 本地数据 (Keychain + config.json)                              │
│  │           └── 代际选择、界面设置、API Key                                 │
│  │                                                                          │
│  Level 1 ─── 本地缓存 (SQLite)                                              │
│  │           └── 工具执行缓存、会话/消息本地副本（可从云端恢复）              │
│  │                                                                          │
│  Level 0 ─── 内存缓存 (ToolCache LRU)                                       │
│              └── 运行时缓存、重启清空                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**各层级详解**:

| 层级 | 存储位置 | 生命周期 | 清空缓存 | 重启应用 | 重装应用 | 换电脑 |
|------|----------|----------|:--------:|:--------:|:--------:|:------:|
| **L0** | 内存 (ToolCache) | 运行时 | 🗑️ | 🗑️ | 🗑️ | 🗑️ |
| **L1** | SQLite | 可清空 | 🗑️ | ✅ | 🗑️ | 🗑️ |
| **L2** | Keychain + config.json | 本地持久 | ✅ | ✅ | ⚠️ | 🗑️ |
| **L3** | Supabase + Keychain | 账户绑定 | ✅ | ✅ | ✅ | ✅* |
| **L4** | Supabase 云端 | 账户绑定 | ✅ | ✅ | ✅ | ✅ |

> ⚠️ = Keychain 数据可恢复（仅限同一台 Mac）
> ✅* = 需要重新登录

---

## 会话渐进加载策略

```
打开应用
     │
     ▼
┌─────────────────────────────────────────┐
│ 1. 返回本地缓存的会话列表（即时响应）    │
│ 2. 后台从云端同步最新列表               │
│ 3. 有更新则通知前端刷新                 │
└─────────────────────────────────────────┘
     │
     ▼
用户点击某个会话
     │
     ▼
┌─────────────┐    否     ┌─────────────────┐
│ 本地有消息？ │──────────▶│ 从云端拉取消息   │
└─────────────┘           │ 缓存到本地       │
     │ 是                  └─────────────────┘
     ▼                            │
显示会话内容 ◀────────────────────┘
```

---

## 缓存策略

**L0 内存缓存 (ToolCache)**:
- 实现: `src/host/services/ToolCache.ts`
- 策略: LRU 缓存，最多 100 条
- TTL: read_file 5分钟, glob/grep 2分钟, web_fetch 15分钟
- 不可缓存: bash, write_file, edit_file (有副作用)

**L1 本地缓存 (SQLite)**:
- 表: `tool_executions` - 工具执行结果缓存
- 表: `sessions` - 会话列表本地副本
- 表: `messages` - 消息内容本地副本
- 清空缓存后，已同步的 sessions/messages 可从 Supabase 重新拉取；runtime state、debug snapshots、preview feedback、local checkpoints 等本地运行态数据不能默认认为可恢复

**L2 本地数据 (Keychain 恢复)**:
```typescript
// ConfigService.syncToKeychain()
{
  generation: 'gen3',
  modelProvider: 'deepseek',
  language: 'zh',
  disclosureLevel: 'standard',
  devModeAutoApprove: true,
}
```

---

## 用户操作映射

| 用户操作 | 清理范围 | 保留 | 恢复方式 |
|----------|----------|------|----------|
| 清空缓存 | L0 + L1 | L2/L3/L4 | 自动从云端拉取 |
| 退出登录 | L3 token | L0/L1/L2/L4 | 重新登录 |
| 重装应用 | L0 + L1 | L2(Keychain) + L3/L4 | 登录后自动恢复 |

---

## SecureStorage 安全存储（v0.6.4）

**位置**: `src/host/services/SecureStorage.ts`

### 设计原则

1. **敏感数据加密存储** - 使用 electron-store 的加密功能
2. **机器绑定密钥** - 加密密钥基于机器特征生成，不可迁移
3. **分层存储策略** - 普通配置 vs Keychain（跨重装保持）

### 加密机制

```typescript
// 机器特征生成加密密钥
const machineId = `${os.hostname()}-${os.userInfo().username}-${app.getPath('userData')}`;
const encryptionKey = crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32);
```

### 存储内容

| 类别 | 数据项 | 存储位置 |
|------|--------|----------|
| **认证** | access_token, refresh_token, session | 加密存储 |
| **设备** | device_id, device_name | 加密存储 |
| **API Key** | deepseek, claude, openai, groq 等 | 加密存储 |
| **设置** | devModeAutoApprove | Keychain（跨重装） |
| **会话** | supabase session | Keychain（跨重装） |

### API Key 管理

```typescript
// 设置 API Key
secureStorage.setApiKey('deepseek', 'sk-xxx');

// 获取 API Key
const key = secureStorage.getApiKey('deepseek');

// 删除 API Key
secureStorage.deleteApiKey('deepseek');

// 列出已配置的 Provider
const providers = secureStorage.getStoredApiKeyProviders();
// → ['deepseek', 'openai']
```

### Keychain 集成

使用 `keytar` 库访问系统 Keychain，数据可在应用重装后恢复：

| 方法 | 用途 |
|------|------|
| `saveSessionToKeychain()` | 保存登录会话 |
| `getSessionFromKeychain()` | 恢复登录状态 |
| `saveSettingsToKeychain()` | 保存用户设置 |
| `getSettingsFromKeychain()` | 恢复用户设置 |

**Keychain 标识**:
- Service: `code-agent`
- Account: `supabase-session` / `user-settings`
