-- ============================================================================
-- Diagnostic bundle telemetry
-- ============================================================================
-- 失败 session 的自包含诊断包(脱敏后):版本指纹 + 环境指纹 + 聚合 span 树 +
-- raw 全量内容,整包存 JSONB。客户端只写自己的行;只有 admin 能读聚合。
-- 用途:用户出问题时脱离其机器复现 agent 轨迹,把"打补丁"变成"按版本归因"。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.telemetry_diagnostic_bundles (
  id                   TEXT PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id            TEXT,
  app_version          TEXT,
  session_id           TEXT NOT NULL,
  -- 版本指纹(从 bundle 反范式化出来,便于按版本切片)
  agent_version        TEXT,
  prompt_version       TEXT,
  tool_schema_version  TEXT,
  -- 触发原因:tool_error / circuit_breaker / outcome_failure / feedback / manual
  trigger_reason       TEXT NOT NULL,
  bundle_version       INTEGER NOT NULL DEFAULT 1,
  built_at             BIGINT,
  -- 脱敏后的 DiagnosticBundle 整包
  bundle               JSONB NOT NULL,
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry_diagnostic_bundles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own diagnostic bundles" ON public.telemetry_diagnostic_bundles;
CREATE POLICY "Users insert own diagnostic bundles" ON public.telemetry_diagnostic_bundles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own diagnostic bundles" ON public.telemetry_diagnostic_bundles;
CREATE POLICY "Users update own diagnostic bundles" ON public.telemetry_diagnostic_bundles
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all diagnostic bundles" ON public.telemetry_diagnostic_bundles;
CREATE POLICY "Admins read all diagnostic bundles" ON public.telemetry_diagnostic_bundles
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_diagnostic_bundles_user_uploaded
  ON public.telemetry_diagnostic_bundles(user_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostic_bundles_session
  ON public.telemetry_diagnostic_bundles(session_id);
CREATE INDEX IF NOT EXISTS idx_diagnostic_bundles_trigger
  ON public.telemetry_diagnostic_bundles(trigger_reason, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostic_bundles_versions
  ON public.telemetry_diagnostic_bundles(agent_version, prompt_version, tool_schema_version);
