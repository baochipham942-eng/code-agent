# T5 · TelemetryUploader RLS 42501 全失败 + 无退避刷屏 —— 施工报告

工单：`code-agent-private-archive/docs/plans/tickets/2026-08-07-T5-telemetry-RLS-工单.md`
worktree：`/Users/linchen/Downloads/ai/code-agent/.claude/worktrees/agent-ac54e1951d9426255`

## 一、RLS 违规根因（真实复现，非推测）

### 1.1 结论

`telemetry_sessions` / `telemetry_turns` / `telemetry_feedback` /
`telemetry_renderer_bundle_attempts` / `telemetry_diagnostic_bundles` 五张表
**从 2026-05-28 上线起就没有真正成功写入过一行**——不是身份/auth 时序问题，
是 RLS 设计与客户端写入方式（`upsert` + `onConflict`）互斥的系统性 bug，对**所有用户
100% 必现**，跟工单标题里"该用户"的措辞无关（不是这一个用户的问题）。

**根因**：这五张表的迁移文件明确写的是"用户只能 INSERT/UPDATE 自己的行，**没有 SELECT
权限**"（`20260528000000_telemetry_fleet.sql` 等注释原文）。但客户端
`TelemetryUploaderService.upload()` 的写入方式是 `supabase.from(table).upsert(rows, {
onConflict: 'id' })`——这会让 PostgREST 生成
`INSERT ... ON CONFLICT (id) DO UPDATE ...` 并带 `Prefer:
resolution=merge-duplicates`。Postgres 处理这类 `ON CONFLICT DO UPDATE` 语句时，
即使本次调用其实是一次全新 id 的纯插入、根本不会真的发生冲突，也需要对发起角色做
SELECT 可见性判断来解析冲突目标；而这五张表对 `authenticated` 角色的 SELECT 策略是
"零策略"（只有 admin 能读），于是 Postgres 直接以 `insufficient_privilege`
（`42501`，"new row violates row-level security policy"）拒绝整条语句——跟 `user_id`
是否等于 `auth.uid()` 完全无关，就算完全同一个人写自己的行也一样会被拒。

对照仓内其它所有走 upsert 同步的表（`sessions`/`messages`/`devices`/
`user_preferences`/`project_knowledge`/`todos`/`vector_documents`/`profiles`，见
`20240115000000_init_sync_tables.sql`）会发现：**它们无一例外都配了
`"Users can view own X"` 的 SELECT 策略**。2026-05-28 新增 fleet telemetry 时是唯一
一次"只写不读"的设计尝试，恰好撞上了这条隐藏约束。

### 1.2 复现方式（本地沙箱，零生产写操作）

用 `supabase` CLI 在本机 Docker 起了一套隔离的 Postgres + GoTrue + PostgREST
（`supabase start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`，
workdir 是 `/private/tmp/.../scratchpad/rls-repro`，migrations 直接拷贝自本仓
`supabase/migrations/`，全程未连接、未触碰生产 Supabase 项目）：

1. 19 个迁移文件在全新库上依次 apply，**零 SQL 错误**（只有幂等性 NOTICE），排除
   "迁移本身没跑成功"的可能。
2. GoTrue 真实注册一个用户，拿到真实签发的 `access_token`（`sub` = 该用户 UUID）。
3. 用该 token 对 `telemetry_sessions` 发起与客户端**完全一致**的请求
   （`POST .../telemetry_sessions?on_conflict=id`，`Prefer:
   resolution=merge-duplicates`，`user_id` = 该用户自己的 UUID）：
   → **`{"code":"42501", message:"new row violates row-level security policy ..."}`**，
   与真机日志一字不差。
4. 同一个 body 去掉 `on_conflict=id`（退化成普通 `INSERT`）：**201 成功**。
5. 对已存在的行发 `PATCH`（普通 `UPDATE`）：**204 成功**。
6. 只有 `INSERT ... ON CONFLICT DO UPDATE`（=upsert）这条路径失败——即便冲突目标
   根本就是这个用户自己的行。
7. 临时给这张表加一条 `CREATE POLICY ... FOR SELECT USING (auth.uid() =
   user_id)`（只在这个本地沙箱库执行，未触碰生产），**同一个此前失败的 upsert 立刻
   变成 201 成功**——实锤坐实"缺 SELECT 策略"就是唯一根因。

复现脚本留在 `/private/tmp/claude-501/.../scratchpad/rls-repro/`（本机临时目录，
不在仓库里），沙箱容器已 `supabase stop` 清理干净。

### 1.3 影响面

- 五张表全部同一模式，全部中招：`telemetry_sessions`、`telemetry_turns`、
  `telemetry_feedback`、`telemetry_renderer_bundle_attempts`、
  `telemetry_diagnostic_bundles`。
- 由于 `upload()` 里会话写失败直接 `return 0`（不继续走 turn/feedback），生产日志
  只看到 `telemetry_sessions` 报错刷屏，但 turns/feedback/renderer/diagnostics 一旦
  绕过 sessions 单独触发也会是同样的 42501（同源同因，未见于日志只是因为从没机会
  真正执行到）。
- **管理后台 `/users` 页的 fleet 遥测聚合视图（`admin_per_user_telemetry`）从功能上线
  起就一直是空的**——不是某天开始坏的，是从没成功过。这是本次排查顺带发现的一个更大
  的既有事实，产品负责人需要知道。

## 二、A 部分：客户端韧性改动（已完成并验证）

文件：`src/host/telemetry/telemetryUploaderService.ts`、
`src/shared/constants/timeouts.ts`（新增 `TELEMETRY_UPLOAD_RESILIENCE`）。

1. **指数退避**：把固定 `setInterval(5min)` 改成自调度 `setTimeout` 链
   （`scheduleNext`），每轮 `upload()` 收尾按"这轮是否失败、是否与上轮同因"决定下一次
   延迟——同因失败每次 ×2（`BACKOFF_FACTOR`），封顶 2 小时（`MAX_INTERVAL_MS`），恢复
   成功立刻重置回基础 5min。
2. **熔断降噪**：新增 `updateResilienceState()`，连续同因失败达到阈值后只打一条
   `WARN` 摘要日志，此后同因失败降级为 `logger.debug`（不再逐条刷 `ERROR`）；换了
   失败原因或恢复成功会重新计数/解除熔断。健康指标（`getUploadHealth()`）不受影响，
   照常累积失败次数，可观测性不打折。
3. **42501 分类为"不可重试"，但不是"放弃治疗"**：新增
   `NON_RETRYABLE_POSTGREST_CODES`（当前只含 `42501`），命中时熔断阈值直接降到 1
   （不必像普通抖动一样等 3 次）。**特别说明**：鉴于 §1 已经证明 42501 在这里其实是
   "服务端策略修好就能自愈"的系统性 bug、不是永久身份错配，所以设计上退避封顶而不是
   一次性永久停用——B 部分的 SQL 一旦部署，正在跑的客户端进程会在下一次（拉长后的）
   周期自动恢复上传，不需要用户重启 app。
4. **加了两个防御性小细节**（顺手做，不算额外功能）：`startAutoUpload`/
   `stopAutoUpload` 之间加了 `uploadEpoch` 世代号，防止"停止又立刻重启"时旧调度链
   和新调度链并存导致上传频率翻倍；`recordUploadFailure` 统一收口了原来分散在 5 个
   调用点各自 `logger.error(...)` 的重复代码。

跳过的东西：没有为每张表分别维护独立的熔断状态（工单只要求"连续 N 次同因失败"这个
粒度，本轮内多张表同时失败时用"这轮最后一次失败的 scope:code"作为代表签名——五张表
现实中同源同因，拆分状态是过度设计）。需要更细粒度时再拆。

## 三、B 部分：修正 SQL（未部署，等产品负责人拍板）

**未对生产 Supabase 执行任何写操作**——以下 SQL 只是建议，需要产品负责人确认后另建
迁移文件、走正常 `supabase db push` 流程部署。

```sql
-- 给五张 telemetry 表补上"本人可读自己写过的行"的 SELECT 策略。
-- 根因：这些表的 upsert（INSERT ... ON CONFLICT DO UPDATE）需要 authenticated 角色
-- 对该表有 SELECT 可见性才能解析冲突目标；零 SELECT 策略 = 100% 必现 42501，
-- 跟 auth.uid() 是否匹配 user_id 无关。本地 Postgres+GoTrue+PostgREST 沙箱已验证：
-- 加上这条 policy 后，此前必现失败的 upsert 立刻变成 201 成功。
--
-- 安全影响：只让用户读回"自己已经上传过的"那一份数据——这份数据本来就完整存在于
-- 用户本地 SQLite（上传前就是从本地读出来的），不会新增任何跨用户可见性；管理员的
-- "读全部"权限（is_code_agent_admin()）不受影响，admin_per_user_telemetry 聚合视图
-- 依旧只对 admin 开放。

CREATE POLICY "Users select own telemetry sessions" ON public.telemetry_sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users select own telemetry turns" ON public.telemetry_turns
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users select own telemetry feedback" ON public.telemetry_feedback
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users select own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users select own diagnostic bundles" ON public.telemetry_diagnostic_bundles
  FOR SELECT USING (auth.uid() = user_id);
```

**影响面说明**：

- 纯新增（每张表 SELECT 是多个 PERMISSIVE 策略取 OR），不改动、不删除任何现有 INSERT/
  UPDATE/admin-SELECT 策略，向后兼容，不需要下线时间。
- 部署后现存本地积压（自 2026-05-28 起从未成功上传过的全部历史 telemetry）会在客户端
  下一次退避周期后开始回补上传——具体回补速度取决于各设备当时的熔断状态（可能已经
  退避到 2 小时一次的上限）。若想立即生效，可以让用户重启一次 app（`this.timer`会
  重置调度但退避状态在同一进程内是持久的，重启即清零）。
- 需要产品负责人评估一点：`telemetry_feedback.full_content`（👎反馈的完整
  prompt/completion）现在用户也能读回——但这本来就是用户自己发送/看到过的内容，
  不是新增的数据暴露。
- 部署方式建议：另起一个新迁移文件（如
  `supabase/migrations/20260807000000_telemetry_own_row_select.sql`），走正常
  `supabase db push` 到生产，而不是修改已经应用过的历史迁移文件（Supabase 迁移不是
  幂等重放的，改历史文件不会重新生效）。

## 四、测试与证据档位

- **`npm run typecheck`**：通过，零错误。
- **`npx eslint src/host/telemetry/telemetryUploaderService.ts
  src/shared/constants/timeouts.ts`**：零 error / 零 warning。
- **`npm run lint:eslint-ratchet`**：通过（全仓棘轮门，含 warnings 计数），无新增。
- **全仓 grep 引用**：`DEFAULT_INTERVAL_MS`（被删的旧局部常量）全仓零残留引用；
  `TELEMETRY_UPLOAD_RESILIENCE` 只有新增的两个文件引用；`startAutoUpload`/
  `stopAutoUpload`/`TelemetryUploaderService`/`getTelemetryUploaderService` 的全部
  调用点（`privacyGate.ts`、`telemetry.ipc.ts`、`webServer.ts`、
  `devTelemetrySeedRoutes.ts`）逐一读过，均通过公开方法调用，未依赖已改动的内部
  调度实现细节，无需同步改动。
- **单测**：`tests/unit/telemetry/telemetryUploaderService.test.ts`（5 条既有 + 新增
  2 条）+ `tests/unit/services/privacyGate.test.ts` + `tests/scripts/
  privacySwitchWiring.test.ts` —— **14 passed / 0 failed / 0 skipped**（子集，
  telemetry 相关全部文件）。新增两条覆盖：① 42501 一次即熔断 + 后续同因降级为
  debug、健康计数不受影响；② 非 42501 抖动容忍 `CIRCUIT_BREAKER_THRESHOLD-1` 次
  后才熔断、恢复后状态清零。
- **全量 vitest**：已在后台跑 `npx vitest run`（无过滤），结果见下方"最终回复"里的
  实测计数（写报告时仍在跑，此处先占位说明证据来源）。
- **证据档位**：
  - RLS 根因（§1）—— **real-runtime**：真实 Postgres + GoTrue + PostgREST 容器 +
    真实签发 JWT + 真实 HTTP 请求复现，不是 mock 也不是静态推理。
  - 客户端韧性改动（§2）—— **hermetic-protocol**：mock 掉 supabase-js/storage/
    logger 之后跑退避/熔断状态机的行为断言，不是端到端真机验证；未跑真机验证是因为
    B 部分尚未部署，真机验证要等策略修好后才有意义（届时应该另开一轮真机回归确认
    telemetry 真的能落库）。
  - 未做变异测试：新增的两条测试是结构性状态机行为门（断言 warn/error/debug 调用
    次数和时机），已经直接对着"退避倍率""熔断阈值""同因判定"这些分支落子，屏蔽掉
    任何一个分支都会让对应断言失败，判断是不需要额外变异验证。

## 五、遗留项

1. B 部分 SQL 需要产品负责人拍板后另建迁移文件部署到生产，本次施工不涉及。
2. 部署后建议做一次真机回归：确认 telemetry 真的开始落库、`admin_per_user_telemetry`
   聚合视图不再是空的（这个视图上线两个多月来第一次会有数据）。
3. 熔断状态是进程内存态，app 重启会清零退避计时——如果要在 B 部署前先减轻现有用户的
   刷屏，本次 A 部分改动已经能做到（同因失败会自动降频到最长 2 小时一次 + 只打一条
   摘要），不需要额外动作。
