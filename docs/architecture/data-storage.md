# 数据存储架构

> SQLite + Supabase + pgvector

## 本地存储 (SQLite)

**位置**: `~/.code-agent/data.db`

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
| `telemetry_sessions / telemetry_turns / telemetry_model_calls / telemetry_tool_calls / telemetry_events` | structured replay 与 eval completeness gate 的事实来源 | `TelemetryCollector` / `TelemetryStorage` |

当前边界：unit 级恢复链已经覆盖 todos、session_tasks、context interventions、runtime state、pending approvals、structured replay；完整 app restart / reload smoke 仍按对应计划文档里的延后风险处理。

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
- 清空缓存后可从云端重新拉取

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
