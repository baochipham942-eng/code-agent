# TODOS

## Agent Core

### Light Memory 清理旧 vector/embedding 代码

**What:** 删除已废弃的 HybridSearch/RRF/entity_relations 旧记忆系统代码（~13K 行）
**Why:** 降低维护负担，新 Light Memory（~553 行）已完全替代
**Context:** 旧系统在 v0.16.x 已停用，前端面板已适配新系统
**Effort:** S
**Priority:** P2
**Depends on:** 确认 Light Memory 稳定运行 2 周+

## 评测

### 增量修改场景评测用例

**What:** 针对 P0 问题构建专项 Eval Set — 多轮对话中的文件读取→修改→再修改链路
**Why:** 没有评测就无法量化修复效果，避免"修了又回归"
**Context:** 已有咖啡店 GUI 测试 case 可作为种子，需要扩充到 5+ 场景
**Effort:** M
**Priority:** P1
**Depends on:** 无

## 可观测性回传（Fleet Observability）

> 完整设计见 [docs/plans/2026-05-28-fleet-observability-plan.md](docs/plans/2026-05-28-fleet-observability-plan.md)。
> 核心问题：app 已分发给用户，但崩溃/LLM trace/usage 全留在用户本机，开发者收不到、无法按 sessionId 跨用户查根因。
>
> 监控分三类各用成熟产品，不自造轮子：崩溃→Sentry、LLM trace→Langfuse(已接，待回传)、产品行为→PostHog。唯一自建的是"分发客户端→开发者中央台"的回传管道(Vercel endpoint + Supabase 表)——桌面应用拿不到 web SaaS 那种"请求自动过你服务器"的免费可观测性，这层胶水必须自己写。
>
> ⚠️ **强约束**：所有"看数据"的能力（查崩溃/查 trace/按 sessionId 根因/per-user 成本/控制台）**只有管理员能用**。用户端单向上报，中央表 RLS 只放行 `is_code_agent_admin()`、客户端只写不读；控制台走 is_admin 门且不打进分发包。本机自己 telemetry 查看不受影响。

### 崩溃/错误回传（Sentry + Rust 脏标记）

**What:** renderer 接 `@sentry/react`（ErrorBoundary.tsx:35 的 TODO）+ node webServer 接 `@sentry/node`（lifecycle.ts:91-96 现成 handler）+ Rust shell 启动脏标记检测崩溃；`beforeSend` 复用 sensitiveDataGuard 脱敏，崩溃报告永不含代码
**Why:** 现在用户 app 闪退/报错开发者一无所知，没法知道"有多少用户崩了、崩在哪"
**Context:** DSN 是 write-only 可嵌入分发包；Rust `panic=abort` 用脏标记不做进程内捕获；P0 独立、当天能验
**Effort:** M
**Priority:** P1
**Depends on:** 无
**Progress:** 代码全部落地且 typecheck 通过（worktree 分支 `worktree-fleet-observability`，9 源文件 / +351 行）。新增 `shared/observability/scrubEvent.ts`（两端共用脱敏）+ `main/observability/sentryNode.ts` + `main/observability/crashMarker.ts`（脏标记，Node 实现，连 Rust shell 崩溃一起兜）+ `renderer/observability/sentryRenderer.ts`；接线 renderer 入口/ErrorBoundary/main 入口/webServer/lifecycle 两个 handler；settings 加 `crashReporting.enabled`。脏标记**改用 Node `process.on('exit')` 而非 Rust**（更优，见计划文档决策记录）。**DSN 已配**：`~/.code-agent/.env`(SENTRY_DSN) + worktree `.env`(SENTRY_DSN + VITE_SENTRY_DSN)。**发送侧已验证**：live 冒烟用真实 DSN 经代理发出一条带假密钥+家目录的事件，client/lastEventId/flush 三重确认送达。**剩余**：把本分支构建进 app，在真实 Tauri webview 里触发 renderer/node 崩溃做完整 in-app E2E（vitest/冒烟过 ≠ UI mount 过）；用户在 Sentry 看板确认收到且脱敏正确。

### LLM trace 回传后端（Supabase 表 + admin-only RLS）

**What:** 新建 `telemetry_sessions/turns/feedback` 表 + RLS（照 init_sync_tables + control_plane_governance 模板）。**架构决策**：客户端直连 supabase-js 写自己的行（复用 syncService 模式），**不建 Vercel 端点/不用 service role**——更简、满足 admin-only-read。
**Why:** 让分发用户的 trace 流到开发者自己的中央台，支撑"按 sessionId 跨用户查根因"和 per-user 成本聚合
**Context:** 不把 Langfuse key 塞客户端（否则 trace 落用户自己 Langfuse）；admin 地基 is_admin/is_code_agent_admin() 已现成
**Effort:** M
**Priority:** P1
**Depends on:** 无
**Progress:** ✅ migration `supabase/migrations/20260528000000_telemetry_fleet.sql` 已写（admin-only RLS：用户写自己、仅 admin 读）。✅ 本地存储层：`migrations.ts` 加 `telemetry_sessions.synced_at` 列 + telemetryStorage `getUnsyncedSessions()`/`markSessionsSynced()`，typecheck 通过。**待办**：用户把 migration apply 到 Supabase；建上传器 `telemetryUploaderService.ts`（下一个任务）。

### LLM trace 回传客户端（上传器 + 反馈入口）

**What:** 新建 `telemetryUploaderService.ts`（抄 syncService 的 upsert+批量+定时 loop），从本地 telemetry SQLite 增量上传；默认 metadata-only，全文仅 👎/报障时上传（脱敏）；renderer Turn 组件加 👍/👎 入口
**Why:** 后端有表也要客户端推上去才闭环；👎 队列直接喂现有 eval set
**Context:** userId 走 authService.getCurrentUser()?.id（telemetryCollector.ts:105 已写入）；需给 telemetryStorage 加 synced_at 列（先确认本地 schema 升级机制）
**Effort:** M
**Priority:** P1
**Depends on:** LLM trace 回传后端

### 产品分析埋点（PostHog）

**What:** renderer 接 posthog-js + webServer 接 posthog-node，埋 app_opened/session_started/model_selected/tool_used/run_completed|failed，distinct_id = hash(userId)
**Why:** 现在用户怎么用产品（功能使用/留存/漏斗）完全是黑盒
**Context:** 免费档够用，opt-out 尊重；独立于崩溃和 trace 回传
**Effort:** M
**Priority:** P2
**Depends on:** 无

### Admin 控制台 UI（独立 web）

**What:** 独立 Next.js on Vercel 控制台（admin RLS 读 Supabase）：用户列表+per-user 用量成本、错误/崩溃趋势、按 sessionId 下钻查根因、👎 反馈队列
**Why:** 对标老师那个 ExcelMaster 控制台，把"输入 sessionId 查根因"变成真实可用的 UI
**Context:** 后端地基（entitlements/audit/is_admin）已有只缺前端；不打进分发包
**Effort:** L
**Priority:** P3
**Depends on:** LLM trace 回传后端、崩溃/错误回传

## Completed

### 修复 Observation Masking 导致的工具调用失控 ✅ 2026-03-20

**What:** 多轮对话中 observationMask 清除 Read 结果后，模型用 Bash 反复读文件，触发 51 次工具调用死循环
**Resolution:** commit `c8a8db1d` — 4 层防御落地
1. L1 止血：Placeholder 文本改为不指示重读
2. L2 推迟：压缩阈值 0.6→0.75，PRESERVE_RECENT 6→10
3. L3 检测：AntiPatternDetector 新增 trackFileReread，3+ 次触发警告
4. L4 根治：智能 Masking 保护活跃文件最后一次 Read 结果
**Files:** `src/shared/constants/agent.ts`、`src/main/context/{autoCompressor,tokenOptimizer}.ts`、`src/main/agent/antiPattern/detector.ts`
**Verification:** 预期工具调用从 51 降到 <15，需长对话场景验证效果
