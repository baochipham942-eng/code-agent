# 数据存储架构

> SQLite + Supabase + pgvector

## 本地存储 (SQLite)

**位置**: `app.getPath('userData')/code-agent.db`

本地数据库由 `src/main/services/core/databaseService.ts` 初始化，路径来自平台层 `app.getPath('userData')`，不是旧文档里的 `~/.code-agent/data.db`。初始化已拆成四类职责：

| 模块 | 职责 |
|------|------|
| `src/main/services/core/database/schema.ts` | 主 schema 与幂等列迁移 |
| `src/main/services/core/database/indexes.ts` | sessions、messages、telemetry、snapshot、checkpoint 等索引 |
| `src/main/services/core/database/migrations/*` | 专项迁移和历史兼容 |
| `src/main/services/core/database/nativeLoader.ts` | better-sqlite3 native binding 加载 |

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
| `messages.compaction` | manual compact / autocompact 的 compaction survivor 信息 | `contextHealth.ipc.ts` / `contextAssembly/compression.ts` |
| `todos` | auto todo 与 finalizer 消费的 session-scoped todo 状态 | `src/main/agent/todoParser.ts` |
| `session_tasks` | Task tool / planning taskStore 的 durable task graph | `src/main/services/planning/taskStore.ts` |
| `context_interventions` | pin / exclude / retain 等手动上下文干预，按 session + agent 持久化 | `src/main/context/contextInterventionState.ts` |
| `session_runtime_state` | `compression_state_json` 与 `persistent_system_context_json`，供 reload 后恢复 ContextAssembly 状态 | `src/main/agent/runtime/runtimeStatePersistence.ts` |
| `pending_approvals.kind` | plan approval 与 swarm launch approval 共用表但按 kind hydrate/orphan，避免互相抢状态 | `PendingApprovalRepository` |
| `swarm_runs / swarm_run_agents / swarm_run_events` | Agent Team run、agent rollup、timeline event | `SwarmTraceWriter` |
| `review_queue_items / review_queue_failure_assets` | Review Queue 与 failure-to-capability asset draft | `ReviewQueueService` |
| `review_queue_items.delivery_review` | Delivery Review 未通过时进入 review queue，保存 artifact 验收结果与修复建议 | `DeliveryReviewService` / `ReviewQueueService` |
| `preview_feedback_items` | Workspace Preview 的反馈项：来源、状态、severity、message、artifact/preview id，可 resolve/dismiss/send back to chat | `PreviewFeedbackService` |
| `telemetry_sessions / telemetry_turns / telemetry_model_calls / telemetry_tool_calls / telemetry_events` | structured replay 与 eval completeness gate 的事实来源 | `TelemetryCollector` / `TelemetryStorage` |
| `turn_snapshots / compaction_snapshots` | 调试快照与压缩前后诊断，支持 CLI debug 和 settings retention | `turnSnapshotWriter` / `compactionSnapshotWriter` |

当前边界：unit 级恢复链已经覆盖 todos、session_tasks、context interventions、runtime state、pending approvals、structured replay；完整 app restart / reload smoke 仍按对应计划文档里的延后风险处理。

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

本地 SQLite schema 在 `src/main/services/core/database/schema.ts` 里幂等迁移；云端 Supabase 迁移是 `supabase/migrations/20260511000000_prompt_rewind.sql`，同步增加 `public.messages.visibility / hidden_by_rewind_id / hidden_at` 和 `public.session_rewinds`，并对 `session_rewinds` 开启 RLS。

### 2026-05-15~17 Agent Neo 管理与外部 engine 状态

这轮新增的状态分成三类：本地 session engine 元数据、主进程内 task ledger，以及 Supabase 管理面。外部 Agent Engine 的具体日志文件留在本地文件系统，SQLite 只保存 session 上的 engine metadata，不把 CLI 原始 jsonl 全量塞进 messages。

| 存储 / 字段 | 用途 | 主要路径 |
|-------------|------|----------|
| `sessions.agent_engine` | 保存当前 session 选择的 engine：`native / codex_cli / claude_code`、外部 engine model、permission profile、cwd、run/log 外部引用 | `src/shared/contract/agentEngine.ts`、`SessionRepository` |
| `config.json.models.agentEngines` | 保存本机对 Codex / Claude 外部 engine 的默认模型偏好；真实可选模型仍以签名 control-plane catalog 为准 | `src/shared/contract/settings.ts`、`ModelSettings.tsx` |
| 外部 engine log path | Codex / Claude 执行的原始流与输出引用，作为 task output ref 回到 TaskPanel | `codexCliAdapter.ts`、`claudeCodeAdapter.ts` |
| `BackgroundTaskLedger` 内存账本 | shell/background task、PTY、外部 engine 的 `Task / TaskEvent / TaskNotification / TaskOutputRef` 统一视图；按 session drain 通知 | `src/main/tasks/backgroundTaskLedger.ts`、`backgroundTaskLedger.ipc.ts` |
| 记忆条目运行态 | 导入候选、条目 CRUD、注入 trace 与 seed memory 注入，不再只靠 Light Memory 文件树裸展示 | `src/main/memory/memoryEntryRuntime.ts`、`memoryInjectionTrace.ts`、`seedMemoryInjector.ts` |
| Capability draft 文件 | MCP template 安装先写项目 `.code-agent/mcp.json` disabled draft；draft 带 `capabilityDraft` 元数据，删除时只移除自己生成的草稿 | `capabilityCenterService.ts`、`capabilityDraftResolver.ts` |
| `public.profiles.status / signup_source / invite_code / last_active_at` | 管理员用户 dashboard 的用户状态、来源和活跃信息 | `supabase/migrations/20260516000000_user_invite_management.sql` |
| `public.invite_codes` 扩展字段 | label、created_by、updated_at、last_used_at，支持 invite code 管理页 | `supabase/migrations/20260516000000_user_invite_management.sql` |
| Admin RPC | `admin_list_users / admin_list_invite_codes / admin_create_invite_code / admin_update_invite_code`，所有函数先走 `require_code_agent_admin()` | `adminService.ts`、`admin.ipc.ts` |
| Supabase explicit grants | 给 public schema 的现有和未来表/序列/函数补显式 grant，防止 Supabase Data API 默认权限改版后返回 42501 | `supabase/migrations/20260515000000_explicit_grants.sql` |

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

### 2026-05 delivery review / evidence durable state

交付验收和评测证据分成三层存储：

| 存储 | 用途 | 主要路径 |
|------|------|----------|
| `preview_feedback_items` | Workspace Preview 侧栏里的人工/自动反馈项，支持 `delivery_review` 来源和用户手动反馈 | `src/main/evaluation/previewFeedbackService.ts` |
| `review_queue_items.delivery_review` | Delivery Review 失败后入 Review Queue，用同一队列处理待审 session、失败资产和交付验收 | `src/main/evaluation/deliveryReviewService.ts`、`reviewQueueService.ts` |
| Canonical eval run | SWE-bench 等外部评测结果转换成 `CanonicalEvalRun` 后进入产品 Experiment DB | `eval/swe-bench/persistence.ts`、`src/main/evaluation/experimentAdapter.ts` |
| Evidence graph DB | Evidence → Proposal → Rule 的实验关系图，当前独立 SQLite，默认路径仍是 `~/.claude/evidence-graph.db` | `src/main/evaluation/evidence/evidenceDb.ts`、`schema.ts` |

这里的 delivery review 是产品运行时数据；audit 计划和 handoff 文档只作为过程材料，不进入普通会话 transcript。

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
- 实现: `src/main/services/ToolCache.ts`
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

**位置**: `src/main/services/SecureStorage.ts`

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
