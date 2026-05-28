-- ============================================================================
-- Fleet telemetry: 分发用户的会话遥测回传（admin-only 读）
-- ============================================================================
-- 设计见 docs/plans/2026-05-28-fleet-observability-plan.md
--
-- 访问控制（强约束「只有管理员能看」）：
--   - 客户端以登录用户身份直连 supabase-js 写自己的行（复用 syncService 既有模式，
--     不走额外 Vercel 端点/ service role）。
--   - 用户只能 INSERT/UPDATE 自己的行（auth.uid() = user_id），**没有 SELECT 权限**。
--   - 只有管理员（public.is_code_agent_admin()）能读全部，用于跨用户查根因 / per-user 聚合。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 会话级（聚合，默认全量上报）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_sessions (
  id                   TEXT PRIMARY KEY,            -- = 客户端 sessionId
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id            TEXT,
  app_version          TEXT,
  model_provider       TEXT,
  model_name           TEXT,
  session_type         TEXT,
  status               TEXT,                        -- completed / error
  start_time           BIGINT,                      -- 客户端毫秒时间戳
  end_time             BIGINT,
  duration_ms          BIGINT,
  turn_count           INTEGER,
  total_input_tokens   INTEGER,
  total_output_tokens  INTEGER,
  total_tokens         INTEGER,
  estimated_cost       NUMERIC,
  total_tool_calls     INTEGER,
  tool_success_rate    NUMERIC,
  total_errors         INTEGER,
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own telemetry sessions" ON public.telemetry_sessions;
CREATE POLICY "Users insert own telemetry sessions" ON public.telemetry_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own telemetry sessions" ON public.telemetry_sessions;
CREATE POLICY "Users update own telemetry sessions" ON public.telemetry_sessions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all telemetry sessions" ON public.telemetry_sessions;
CREATE POLICY "Admins read all telemetry sessions" ON public.telemetry_sessions
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_user_uploaded
  ON public.telemetry_sessions(user_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_status
  ON public.telemetry_sessions(status);
CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_app_version
  ON public.telemetry_sessions(app_version);

CREATE OR REPLACE FUNCTION public.owns_telemetry_session(p_session_id TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT p_session_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.telemetry_sessions s
    WHERE s.id = p_session_id
      AND s.user_id = auth.uid()
  );
$$;

-- ----------------------------------------------------------------------------
-- Turn 级（根因深度：intent / outcome / tool 摘要 / 报错）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES public.telemetry_sessions(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_number          INTEGER,
  turn_type            TEXT,
  agent_id             TEXT,
  intent               TEXT,
  outcome_status       TEXT,
  duration_ms          BIGINT,
  total_input_tokens   INTEGER,
  total_output_tokens  INTEGER,
  tool_call_count      INTEGER,
  error_count          INTEGER,
  payload              JSONB,    -- modelCalls/toolCalls 摘要 + (仅 👎) prompt/completion，均脱敏
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry_turns ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.owns_telemetry_turn(p_turn_id TEXT, p_session_id TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT p_turn_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.telemetry_turns t
    WHERE t.id = p_turn_id
      AND t.user_id = auth.uid()
      AND (p_session_id IS NULL OR t.session_id = p_session_id)
  );
$$;

DROP POLICY IF EXISTS "Users insert own telemetry turns" ON public.telemetry_turns;
CREATE POLICY "Users insert own telemetry turns" ON public.telemetry_turns
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.owns_telemetry_session(session_id)
  );

DROP POLICY IF EXISTS "Users update own telemetry turns" ON public.telemetry_turns;
CREATE POLICY "Users update own telemetry turns" ON public.telemetry_turns
  FOR UPDATE USING (
    auth.uid() = user_id
    AND public.owns_telemetry_session(session_id)
  ) WITH CHECK (
    auth.uid() = user_id
    AND public.owns_telemetry_session(session_id)
  );

DROP POLICY IF EXISTS "Admins read all telemetry turns" ON public.telemetry_turns;
CREATE POLICY "Admins read all telemetry turns" ON public.telemetry_turns
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_telemetry_turns_session
  ON public.telemetry_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_turns_user
  ON public.telemetry_turns(user_id);

-- ----------------------------------------------------------------------------
-- 反馈（👍/👎；👎 触发该 session 全文上传，也喂 eval set）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_feedback (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           TEXT,
  turn_id              TEXT,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating               SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  comment              TEXT,
  full_content         JSONB,    -- 仅 👎/报障时带 prompt+completion（脱敏）
  created_at           BIGINT,   -- 客户端毫秒时间戳
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own telemetry feedback" ON public.telemetry_feedback;
CREATE POLICY "Users insert own telemetry feedback" ON public.telemetry_feedback
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND (session_id IS NULL OR public.owns_telemetry_session(session_id))
    AND (turn_id IS NULL OR public.owns_telemetry_turn(turn_id, session_id))
  );

DROP POLICY IF EXISTS "Users update own telemetry feedback" ON public.telemetry_feedback;
CREATE POLICY "Users update own telemetry feedback" ON public.telemetry_feedback
  FOR UPDATE USING (
    auth.uid() = user_id
    AND (session_id IS NULL OR public.owns_telemetry_session(session_id))
    AND (turn_id IS NULL OR public.owns_telemetry_turn(turn_id, session_id))
  ) WITH CHECK (
    auth.uid() = user_id
    AND (session_id IS NULL OR public.owns_telemetry_session(session_id))
    AND (turn_id IS NULL OR public.owns_telemetry_turn(turn_id, session_id))
  );

DROP POLICY IF EXISTS "Admins read all telemetry feedback" ON public.telemetry_feedback;
CREATE POLICY "Admins read all telemetry feedback" ON public.telemetry_feedback
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_telemetry_feedback_rating
  ON public.telemetry_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_telemetry_feedback_session
  ON public.telemetry_feedback(session_id);
