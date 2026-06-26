# Fleet Observability

> 分发用户三阶段可观测性闭环：崩溃回传 + LLM trace 回传 + admin 控制台 + 行为分析

完整实施 plan：[docs/plans/2026-05-28-fleet-observability-plan.md](../plans/2026-05-28-fleet-observability-plan.md)
落地 commit：`8a764459`

## 三个阶段

| 阶段 | 内容 | 后端 |
|------|------|------|
| **P0 崩溃回传** | renderer + node 双侧 Sentry，共用 `scrubEvent` 脱敏（密钥 / 家目录 / extra 递归） | Sentry |
| **P1 LLM trace 回传** | telemetry sessions / turns / feedback 三表 + admin-only RLS + auth-gated metadata-only 上传器 | Supabase |
| **P2 admin 控制台 + 行为分析** | Next.js 16 + `@supabase/ssr` 子 app；PostHog 代码侧接线 + 3 看板 + 8 insights 规格 | Vercel + PostHog |

## P1 上传器启停（webServer 路径，2026-06-03）

发行版的真实运行路径是 **Tauri + webServer**，不是 Electron main。上传器 (`telemetryUploaderService`) 此前只在 Electron main 的 `initBackgroundServices.ts` 里启动，发行版没人调它 —— 生产 telemetry 表长期只有冒烟数据，线上 trace 零回传。

现在 (as-built) 在 `src/web/webServer.ts:initializeServices()` **步骤 5** 做 auth-gated 启停：

- **登录起、登出停**：通过 `authService.addAuthChangeCallback(syncTelemetryUploader)` 跟随登录态，`user` 非空 `startAutoUpload()`、为空 `stopAutoUpload()`。
- **必须在 DB init 之后**：`upload()` 要读本地 telemetry 表，而 auth 恢复（步骤 3）早于 DB 就绪，所以这里用 `authService.getCurrentUser()` 按已恢复的登录态补一次启动。
- **E2E 模式跳过**：`CODE_AGENT_E2E === '1'` 时只记日志不启动，避免测试环境往云端回传。
- 全程 try/catch 包裹，上传器不可用只 `logger.warn` 降级，不阻塞服务初始化。

## 关键文件

### 客户端侧

| 路径 | 角色 |
|------|------|
| `src/host/observability/sentryNode.ts` | Node 侧 Sentry init + transport 走 scrubEvent |
| `src/host/observability/crashMarker.ts` | Node 脏标记：进程异常退出时下次启动回传 crash event |
| `src/host/observability/posthogNode.ts` | Node 侧 PostHog client（distinct_id 用 sha256 hash，不暴露 raw Supabase UUID） |
| `src/renderer/observability/sentryRenderer.ts` | renderer 侧 Sentry init |
| `src/renderer/observability/posthogRenderer.ts` | renderer 侧 PostHog client |
| `src/shared/observability/scrubEvent.ts` | 共用脱敏：递归扫描 `extra` / `contexts` / `tags` / `user`，剥密钥 / 家目录 / 信用卡 / Bearer token / SSN |
| `src/shared/observability/posthog-events.ts` | 7 个 event key 常量（`app_opened` / `session_started` / `run_completed` / `run_failed` / `run_cancelled` / `tool_used` / `model_selected`）；`identify` 是 SDK 方法名（`identifyNode` / `identifyRenderer`），不是 event key |
| `src/host/telemetry/telemetryUploaderService.ts` | LLM trace + renderer hot-update attempt 上传器；turn 失败不标记 `synced_at`，热更 attempt 上传失败只保留该批 retry，不阻塞 session/turn |
| `src/host/telemetry/telemetryStorage.ts` | 本地 SQLite 在 `telemetry_sessions` 表加 `synced_at` 列 + 迁移；另存 `telemetry_renderer_bundle_attempts` 作为系统级热更状态事件 |
| `scripts/observability/posthog-dashboards.py` | 幂等创建 3 个 PostHog 看板并反查 8 个 insight；`npm run acceptance:posthog-dashboards:dry-run` 可离线输出规格，`npm run acceptance:posthog-dashboards:verify` 可只做线上核验 |
| `scripts/acceptance/posthog-live-event-smoke.py` | 用 PostHog Project API Key 发无 PII smoke event；优先 HogQL 回读，缺 `query:read` 时 fallback 到临时 insight refresh 回读 |

### 服务端侧

| 路径 | 角色 |
|------|------|
| `admin-console/` | Next.js 16 + `@supabase/ssr` 独立 sub-app（已部署 Vercel） |
| `admin-console/app/page.tsx` | 概览仪表盘 |
| `admin-console/app/sessions/[id]/page.tsx` | 单 session trace 详情 |
| `admin-console/app/users/page.tsx` | 用户列表 |
| `admin-console/app/errors/page.tsx` | 错误聚合、14 天错误趋势和最近错误会话列表 |
| `admin-console/proxy.ts` | 三层 admin gate 第二层（Next proxy level） |

## 三层 Admin Gate

1. **Vercel SSO** — 部署级访问控制
2. **Next.js proxy** — 路由级，未登录的非 admin 用户重定向到 `/unauthorized`
3. **Supabase RLS** — DB 级，行权策略 + 跨表归属校验函数 `owns_telemetry_session(p_session_id TEXT)` / `owns_telemetry_turn(p_turn_id TEXT, p_session_id TEXT DEFAULT NULL)` 防跨用户污染（注：参数是 TEXT 不是 uuid，turn 函数可选第二参数）

## 红线（Codex 对抗式 review 找到 4 处漏洞并修补）

| 漏洞 | 修补 |
|------|------|
| **RLS 跨用户污染**：纯 `auth.uid() = user_id` 过滤在 turn / feedback 表上无法防"伪造 session_id 串到别人 session"的污染 | 加 `owns_telemetry_session` / `owns_telemetry_turn` SECURITY DEFINER 函数，policy 改用归属校验 |
| **上传器 partial-write 丢 turn 数据**：原实现 session 成功就标记，turn 失败也吞 | turn 失败**不**标记 `synced_at`，下次重传 |
| **PostHog distinct_id 隐私加固**：原计划直接用 Supabase UUID | 改 sha256 hash，不可逆向 |
| **scrubEvent 递归脱敏**：原版只扫顶层 `extra`/`contexts` | 改成递归扫描 `extra` / `contexts` / `tags` / `user`，深层嵌套也覆盖 |

每条加测试锁定：`scrubEvent.test.ts` 18 case 红线 + `posthogNode.test.ts` / `telemetryUploaderService.test.ts` 各 1 case，共 20 个 `it()` 跨 3 个新测试文件。

## 验证证据

- 主仓 typecheck + admin-console next build 双绿
- Sentry live event 实证：真实平台上看到的 event payload 脱敏成立（密钥 / 家目录已剥）
- Supabase RLS：`pg_policies` 元数据查询 + headless 真 JWT 双重实查
- Vercel 部署：ready，三层 admin gate 一二三层实测均拦截非 admin 流量
- PostHog 本地规格验：`npm run acceptance:posthog-dashboards:dry-run`
- PostHog dashboard 线上验：`npm run acceptance:posthog-dashboards` 已在项目 `353395` create/reuse 后反查 3 个 dashboard / 8 个 insight
- PostHog ingest + 回读线上验：`npm run acceptance:posthog-live-event` 已返回 `{"status":"Ok"}` 并通过临时 insight refresh 回读到 smoke event；旧 Personal API Key 缺 `query:read` 时自动 fallback

## 与 Sensitive Data Guard 的关系

`scrubEvent` 是 observability 专用的二次脱敏层，与通用 `sensitiveDataGuard` 互补：

- `sensitiveDataGuard`：所有本地 sink（prompt / memory / activity / channel / knowledge / transcript / export / telemetry）的统一脱敏入口
- `scrubEvent`：在 telemetry 数据离开本地、上传到 Sentry / Supabase 之前再过一遍，递归扫描 Sentry event 特定结构（`extra` / `contexts` / `tags` / `user`），防止"本地存好但 Sentry transport 时附加的 breadcrumb / context 把敏感数据带出去"

详见 [sensitive-data-guard.md](sensitive-data-guard.md)。
