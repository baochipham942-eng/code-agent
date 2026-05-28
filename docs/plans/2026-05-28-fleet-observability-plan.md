# Fleet Observability — 分发用户可观测性回传计划

> 状态：Proposed（待动手）
> 日期：2026-05-28
> 背景：Agent Neo 要分发给外部用户。现有可观测性"轮子"造得好，但**全是朝内的**（开发者本机自测），没有一根线把崩溃/trace/usage 从用户机器回传到中央台。本计划补齐"收集端 + 上传器 + 崩溃钩子 + admin 前端"。

## 核心决策

- **走自建回传端，不把 Langfuse / 任何 secret key 塞进客户端。** Langfuse 凭证目前来自用户自己的 SecureStorage（`src/main/services/core/configService.ts:689`、`langfuseService.ts:79-101`），分发后 trace 落在用户自己的 Langfuse，开发者收不到。改为：客户端把已采集好的本地 telemetry 经 Vercel endpoint 写入开发者自己的 Supabase。
- **隐私红线**：默认只传 metadata（模型/延迟/token/报错码），完整 prompt+输出仅在用户点 👎 / 主动报障时上传，且复用现成的 `src/main/security/sensitiveDataGuard.ts` 脱敏。崩溃报告永不含代码。
- **最大化复用**：本地 telemetry 采集（`src/shared/contract/telemetry.ts` 的 `TelemetrySession/Turn/ToolCall`，含 `userId` 列）、Supabase auth（`authService.getCurrentUser()?.id`）、syncService 的 upsert+批量+定时 loop 模式、admin 地基（`is_admin` + `is_code_agent_admin()` + `control_plane_entitlements`）全都现成。

## 现状审计结论（已核实）

| 维度 | 状态 | 关键文件 |
|---|---|---|
| 崩溃上报 | **缺**（本地抓到不回传，Sentry 是 TODO） | `ErrorBoundary.tsx:35`、`lifecycle.ts:91-96` |
| LLM trace | **造好了但朝内**（Langfuse 满配，key 是用户的） | `langfuseService.ts`、`telemetry.ts` |
| Session/correlation ID | **已实现**（端到端串联，真资产） | `conversationRuntime.ts` |
| 隐私脱敏 | **已实现**（回传地基已有） | `sensitiveDataGuard.ts`、`settings.ts:178` |
| 产品分析 | **缺**（无埋点） | — |
| 计费/per-user | **半**（本地算 token/cost，无跨用户聚合） | `modelPricing.ts`、`telemetry.ts:225` |

vercel-api 已有 `v1/control-plane`、`v1/capabilities`，但**无遥测接收端**；supabase 是 auth + 数据同步，**无 telemetry 表**。

## 0. 架构总览

```
分发用户的 App                          开发者的中央台
┌─────────────────────────┐
│ Renderer (React)         │── Sentry JS ──┐
│  ErrorBoundary           │               │
├─────────────────────────┤               ├──→ Sentry.io  (崩溃/错误聚合)
│ Node webServer (agent)   │── Sentry Node─┘
│  uncaughtException       │
│  telemetryStorage(SQLite)│── 上传器 ──→ Vercel /api/v1/telemetry
│   (已采集, 带 userId)     │   (metadata默认,           │ (service role)
│  👍/👎 feedback           │    全文仅👎/报障)           ↓
├─────────────────────────┤                        Supabase
│ Rust shell (Tauri)       │── dirty-flag ──────────→ telemetry_* 表 + RLS
│  panic=abort             │   (下次启动检测)             ↓
└─────────────────────────┘                    Admin 控制台(独立 web)
                                                按 sessionId 查根因 / per-user 聚合
```

Phase 顺序：**P0 崩溃回传** → **P1 LLM trace 回传 + per-user 聚合** → **P2 产品分析 + Admin 控制台 UI**。

## ⚠️ 跨切约束：所有"看数据"的能力只有管理员能用

回传是"用户端单向上报、管理员单向查看"，普通用户不得访问任何聚合/跨用户/查询能力：

| 能力 | 谁能用 | 怎么保证 |
|---|---|---|
| 上报（写 Sentry / telemetry 表 / PostHog） | 用户客户端 | 单向写，DSN/service role 都是 write-only 或服务端持有 |
| 查崩溃（Sentry 看板） | 仅开发者/管理员 | Sentry 项目本身在开发者账号下，不对用户暴露 |
| 查 trace / 按 sessionId 根因 / per-user 成本 | 仅管理员 | 中央表 RLS 只放行 `is_code_agent_admin()`；客户端只写不读 |
| Admin 控制台 | 仅管理员 | 登录后 `is_admin` 门控，且不打进分发包 |
| 本地自己机器的 telemetry 查看（现有 IPC） | 用户本人 | 只是本机自己的数据，不涉及跨用户，保持现状即可 |

> 说明：P0 崩溃上报这一步**不对用户暴露任何东西**——上报是单向写，查看在 Sentry 看板（开发者账号）。约束主要落在 P1 的表 RLS 和 P2 的控制台。

---

## P0 — 崩溃回传

目标：用户 app 崩了/报错，开发者能收到堆栈、版本、OS、匿名 userId。

### 后端
- Sentry 用 sentry.io 免费档（5k errors/月够 MVP）。建 1 个 project，renderer + node 用不同 SDK，靠 tag 区分。
- DSN 构建期通过 env 注入。**DSN 是 write-only 公开值，可安全嵌入分发包**，不是 secret。
- 代码侧实现为：DSN 从 env/config 读取，缺省时禁用（no-op）→ 不阻塞开发，用户填 DSN 即激活。

### 客户端 — 前端 renderer
| 文件 | 改动 |
|---|---|
| `src/renderer` 入口（main.tsx） | `Sentry.init({ dsn, release: appVersion, beforeSend: scrub })`，依赖 `@sentry/react` |
| `src/renderer/components/ErrorBoundary.tsx:35` | Sentry TODO → `Sentry.captureException(error, { tags: { sessionId, userId, os } })` |

### 客户端 — Node webServer / main 进程
| 文件 | 改动 |
|---|---|
| webServer 启动处 | `@sentry/node` init（agent 逻辑跑在这，90% 的 bug 在这里） |
| `src/main/app/lifecycle.ts:91-96` | 现成 `uncaughtException`/`unhandledRejection` handler → 加 `Sentry.captureException` |

### 脏标记法（覆盖 Rust shell 崩溃 + Node 崩溃 + kill -9）
不跟 `panic=abort` 较劲。**实现放 Node 侧而非 Rust**——决策记录见下，比原计划的 Rust 方案更优：
| 文件 | 改动 |
|---|---|
| `src/main/observability/crashMarker.ts`（新建） | 启动时若 `<userData>/.session-running` 仍在 → 上次异常退出 → `captureMessage` 上报（附最近日志尾，脱敏）；随后写本次标记；`process.on('exit')` 干净退出时同步删除 |
| `main/index.ts` + `web/webServer.ts` | `initSentryNode()` 之后调 `initCrashMarker()` |

**为什么挪到 Node（实现中确定的改进）**：
- `process.on('exit')` 是天然的"干净退出"信号；kill -9 / OOM / Rust shell 崩溃 / 断电都不触发 → 标记残留 → 下次启动检测到。因此 Node 侧脏标记**连 Rust shell 崩溃一起兜住**，还省掉 Rust→文件→Node 的多余一跳（Sentry 本就在 Node 层）。
- 不注册 SIGINT/SIGTERM listener（会抑制默认终止、可能让 Ctrl-C 挂起、与 app 既有信号处理冲突），只挂同步 `'exit'` 清理。

> 可选（后续）：接 `sentry` crate + panic hook 里 blocking flush 再 abort，用于**区分**是 Rust panic 还是 Node 崩溃。MVP 的 Node 脏标记已能"知道上次崩了 + 附日志上下文"。

### 隐私（P0 必做）
- Sentry `beforeSend` 复用 `sensitiveDataGuard.ts` 脱敏：剥掉文件路径、代码片段、env、API key。崩溃报告 = 堆栈 + 元数据，永不含 prompt/代码。
- `settings.ts` 加 `crashReporting.enabled`（默认开，元数据敏感度低，但给明确开关）。

---

## P1 — LLM trace 回传 + per-user 聚合

这是"输入 sessionID 跨用户查根因"的本体。最大化复用 syncService。

### 后端 — Supabase migration（新建）
新文件 `supabase/migrations/20260528000000_telemetry_fleet.sql`，照 `20240115000000_init_sync_tables.sql` 模板：

```sql
-- Session 级（聚合，默认全量上传）
CREATE TABLE IF NOT EXISTS public.telemetry_sessions (
  id            TEXT PRIMARY KEY,                       -- = 客户端 sessionId
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- 可空(offline)
  device_id     TEXT,                                   -- offline 兜底归集
  app_version   TEXT,
  model_provider TEXT, model_name TEXT,
  turn_count    INT, total_tokens INT, estimated_cost NUMERIC,
  tool_success_rate NUMERIC, total_errors INT,
  status        TEXT,                                   -- completed/error
  created_at    BIGINT NOT NULL
);
-- Turn 级（根因深度：intent/outcome/tool 摘要/报错）
CREATE TABLE IF NOT EXISTS public.telemetry_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES public.telemetry_sessions(id) ON DELETE CASCADE,
  user_id UUID, turn_number INT, intent TEXT, outcome_status TEXT,
  payload JSONB,            -- 嵌套字段(modelCalls/toolCalls 摘要, 脱敏后)
  created_at BIGINT NOT NULL
);
-- 反馈（👎 是全文上传的触发器，也喂 eval set）
CREATE TABLE IF NOT EXISTS public.telemetry_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT, turn_id TEXT, user_id UUID,
  rating SMALLINT,          -- +1 / -1
  full_content JSONB,       -- 仅 👎/报障时带 prompt+completion(脱敏)
  created_at BIGINT NOT NULL
);
```
- **RLS（强约束：只有管理员能看）**：用户只能 `INSERT/UPDATE` 自己的行（`auth.uid() = user_id`），**没有 SELECT policy**；只有 admin 能读全部（`USING (public.is_code_agent_admin())`）。客户端**只写自己、读不到任何人（含自己）**。（照 `20260517000000_control_plane_governance.sql` 现成 admin-only pattern）
- **索引**：`(user_id, uploaded_at)`、`(status)`（筛错误）、`(app_version)`、turns 的 `(session_id)`。
- 实现文件：`supabase/migrations/20260528000000_telemetry_fleet.sql`（✅ 已写）。

### 🔀 架构决策变更（实现中确定）：直连 supabase-js，不建 Vercel 端点
原计划走 `vercel-api/api/v1/telemetry.ts` + service role。实现时发现 **syncService 既有模式就是客户端直连 supabase-js 以登录用户身份写自己的行、RLS 管控**。telemetry 照搬即可：
- 客户端用 `getSupabase().from('telemetry_sessions').upsert(..., { onConflict: 'id' })`，RLS 保证只能写自己的行。
- **不需要 Vercel 端点、不需要 service role**——更简、复用成熟模式、且满足 admin-only-read。
- 代价：上传 **auth-gated**（仅登录用户上报，与现有 sync 一致）。匿名/登出用户的遥测不回传——非硬需求，若以后要覆盖登出用户再加一个 service-role 端点。

### 客户端 — 上传器（新建，抄 syncService）
新文件 `src/main/telemetry/telemetryUploaderService.ts`，模仿 `src/main/services/sync/syncService.ts`：

| 复用点 | 来源 |
|---|---|
| `startAutoUpload(interval)` 定时 loop | syncService `startAutoSync`（5min） |
| 批量 200 条 + 失败下轮重试（无显式 retry） | syncService 模式 |
| userId 绑定 | `authService.getCurrentUser()?.id`（telemetryCollector.ts:105 已写入 session.userId） |
| 脱敏 | 默认只传 metadata，剥掉 prompt/completion/userPrompt/assistantResponse；全文仅当 session 被 👎 标记 → 复用 `sensitiveDataGuard` |

| 文件 | 改动 |
|---|---|
| `src/main/telemetry/telemetryStorage.ts` | 加 `synced_at` 列 + `getUnsynced()`/`markSynced()`（⚠️ 先确认它的 schema 升级机制，better-sqlite3 是 CREATE 还是有 ALTER 迁移） |
| `src/main/app/initBackgroundServices.ts` | init 上传器（挨着现有 langfuse/sync init，`:191` 附近） |
| `src/shared/contract/settings.ts:171` | langfuse 配置旁加 `telemetry.cloudUpload.enabled` + privacy mode 开关 |

### 客户端 — 反馈入口（前端）
| 文件 | 改动 |
|---|---|
| Turn 渲染组件（renderer） | 加 👍/👎 按钮 → IPC 写本地 `telemetry_feedback` + 给该 session 打"全文上传"标记 |

> 副作用：👎 队列**直接喂现有 eval set**，跟"评测驱动"方法论闭环上。

---

## P2 — 产品分析 + Admin 控制台 UI

### 产品分析
- `posthog-js`（renderer 行为埋点）+ `posthog-node`（webServer 事件）。distinct_id = hash 后的 userId。免费档够用，opt-out 尊重。
- 最小事件集：`app_opened` / `session_started` / `model_selected` / `tool_used` / `run_completed|failed`。

### Admin 控制台（= 老师那个面板的对位）
- **不要把 admin UI 打进分发包。** 建独立 web 控制台（Next.js on Vercel，用 admin RLS 读 Supabase）。
- 后端地基已存在（`control_plane_entitlements` / audit / `is_admin`），只缺前端。面板：
  1. 用户列表 + per-user 用量/成本（`telemetry_sessions` 聚合）
  2. 错误/崩溃趋势（Sentry + `telemetry_sessions WHERE status='error'`）
  3. **按 sessionId 下钻**：搜 sessionId → 拉出 session + turns + tool calls + 关联 Sentry 事件 + 反馈 —— 这就是"查根因"的真实 UI
  4. 👎 反馈队列

---

## 关键技术决策 / 风险

| 项 | 结论 |
|---|---|
| Rust `panic=abort` | 脏标记**在 Node 侧**实现（`crashMarker.ts` + `process.on('exit')`），连 Rust shell 崩溃一起兜，不做进程内捕获 |
| 隐私 | 默认 metadata-only；全文仅 👎/报障；复用 `sensitiveDataGuard`；DSN 可嵌入(write-only)；崩溃报告永不含代码 |
| userId 可空(offline) | 用 `device_id` 兜底，匿名聚合 |
| 成本 | Sentry 免费档 + Supabase(已有) + PostHog 免费档 ≈ 小规模零增量成本 |
| 唯一未知 | `telemetryStorage` 的本地 schema 升级机制要先确认（加 `synced_at` 列怎么平滑迁移老用户的库） |

## 文件清单

**P0 已建**：`src/shared/observability/scrubEvent.ts`、`src/main/observability/sentryNode.ts`、`src/main/observability/crashMarker.ts`、`src/renderer/observability/sentryRenderer.ts`。
**P0 已改**：`renderer/index.tsx`、`ErrorBoundary.tsx`、`main/index.ts`、`web/webServer.ts`、`lifecycle.ts`、`settings.ts`（+`crashReporting.enabled`）、`package.json`（+`@sentry/node`/`@sentry/react`）。
**P1/P2 待建**：`supabase/migrations/20260528000000_telemetry_fleet.sql`、`vercel-api/api/v1/telemetry.ts`、`src/main/telemetry/telemetryUploaderService.ts`、(P2) PostHog 接入 + 独立 admin web。
**P1/P2 待改**：`telemetryStorage.ts`（+`synced_at`）、`initBackgroundServices.ts`、`settings.ts`（+`telemetry.cloudUpload.enabled`）、renderer Turn 组件（👍/👎）。

## 验证（每个 Phase 收尾）

- **P0**：手动 throw renderer error / node uncaughtException → Sentry 收到且脱敏正确；`kill -9` webServer → 下次启动报 previous crash。
- **P1**：跑一个 session → Supabase 收到 session+turns、userId 正确、按 sessionId 能 join 全链路；点 👎 → 全文上传；关 toggle → 不传。
- **P2**：PostHog 见事件；admin 搜 sessionId 出根因。
