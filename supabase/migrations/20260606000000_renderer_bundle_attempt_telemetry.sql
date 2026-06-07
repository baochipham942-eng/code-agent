-- ============================================================================
-- Renderer bundle hot-update attempt telemetry
-- ============================================================================
-- 系统级 metadata-only 上报：回答谁拿到了哪个 renderer bundle、为什么跳过、
-- 失败集中在哪个 reason。客户端只写自己的行；只有 admin 能读聚合。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.telemetry_renderer_bundle_attempts (
  id                                  TEXT PRIMARY KEY,
  user_id                             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id                           TEXT,
  app_version                         TEXT,
  checked_at                          BIGINT NOT NULL,
  manifest_url                        TEXT NOT NULL,
  source_channel                      TEXT,
  source_manifest_url_override        BOOLEAN NOT NULL DEFAULT FALSE,
  source_error_reason                 TEXT,
  source_error_message                TEXT,
  source_error_target                 TEXT,
  current_shell_version               TEXT NOT NULL,
  active_version                      TEXT,
  active_content_hash                 TEXT,
  outcome                             TEXT NOT NULL,
  reason                              TEXT,
  manifest_version                    TEXT,
  manifest_content_hash               TEXT,
  manifest_min_shell_version          TEXT,
  manifest_bundle_url                 TEXT,
  required_shell_capabilities_count   INTEGER NOT NULL DEFAULT 0,
  rollback_to_builtin                 BOOLEAN NOT NULL DEFAULT FALSE,
  rollback_reason                     TEXT,
  missing_shell_capabilities          JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_runtime_assets              JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_resources                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagnostics                         JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message                       TEXT,
  uploaded_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry_renderer_bundle_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts;
CREATE POLICY "Users insert own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts;
CREATE POLICY "Users update own renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts;
CREATE POLICY "Admins read all renderer bundle attempts" ON public.telemetry_renderer_bundle_attempts
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_renderer_bundle_attempts_user_checked
  ON public.telemetry_renderer_bundle_attempts(user_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_renderer_bundle_attempts_outcome_reason
  ON public.telemetry_renderer_bundle_attempts(outcome, reason);
CREATE INDEX IF NOT EXISTS idx_renderer_bundle_attempts_channel_checked
  ON public.telemetry_renderer_bundle_attempts(source_channel, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_renderer_bundle_attempts_manifest_hash
  ON public.telemetry_renderer_bundle_attempts(manifest_content_hash);
