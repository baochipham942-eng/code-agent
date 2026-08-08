-- ============================================================================
-- 修复 telemetry 五张表自 2026-05-28 上线起 100% 写入失败（PostgREST 42501）
-- ============================================================================
-- 根因（本地 Postgres + GoTrue + PostgREST 沙箱实测坐实，见
-- docs/plans/2026-08-07-T5-telemetry-RLS-施工报告.md §1）：
--   客户端 TelemetryUploaderService 用 upsert(rows, { onConflict: 'id' })，
--   PostgREST 生成 INSERT ... ON CONFLICT (id) DO UPDATE。Postgres 处理这类语句时
--   需要对发起角色做 SELECT 可见性判断来解析冲突目标；而这五张表当初刻意设计成
--   「只写不读」（零 authenticated SELECT 策略），于是无论 user_id 是否等于
--   auth.uid()，语句一律被 insufficient_privilege(42501) 拒绝。
--   沙箱验证：加上本人可读策略后，此前必现失败的同一个 upsert 立刻 201 成功。
--
-- 安全影响：只让用户读回「自己已经上传过的」那份数据——这份数据本来就完整存在于
-- 用户本地 SQLite（上传前就是从本地读出来的），不新增任何跨用户可见性。
-- 管理员的「读全部」策略（is_code_agent_admin()）与 admin_per_user_telemetry
-- 聚合视图不受影响，依旧只对 admin 开放。
-- 纯新增（SELECT 多个 PERMISSIVE 策略取 OR），不改不删任何现有策略。
-- ============================================================================

DROP POLICY IF EXISTS "Users select own telemetry sessions" ON public.telemetry_sessions;
CREATE POLICY "Users select own telemetry sessions" ON public.telemetry_sessions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users select own telemetry turns" ON public.telemetry_turns;
CREATE POLICY "Users select own telemetry turns" ON public.telemetry_turns
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users select own telemetry feedback" ON public.telemetry_feedback;
CREATE POLICY "Users select own telemetry feedback" ON public.telemetry_feedback
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users select own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts;
CREATE POLICY "Users select own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users select own diagnostic bundles" ON public.telemetry_diagnostic_bundles;
CREATE POLICY "Users select own diagnostic bundles" ON public.telemetry_diagnostic_bundles
  FOR SELECT USING (auth.uid() = user_id);
