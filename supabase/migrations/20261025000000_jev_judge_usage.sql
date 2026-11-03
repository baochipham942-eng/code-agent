-- Jev hosted judge usage counters (N-JEV-NEO-KEY).
-- Per-user-per-day call quota (default 500) + global-per-day cost fuse (default $1).
-- Rows are written only by the server role (Vercel jev-judge handler via DATABASE_URL);
-- RLS is enabled with no policies so client roles (anon/authenticated) can neither read
-- nor write. Request bodies / answers are never stored here — only counters.

CREATE TABLE IF NOT EXISTS public.jev_judge_user_usage (
  user_id TEXT NOT NULL,
  day DATE NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0,
  est_cost_usd NUMERIC(14, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS public.jev_judge_global_usage (
  day DATE PRIMARY KEY,
  calls BIGINT NOT NULL DEFAULT 0,
  est_cost_usd NUMERIC(14, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.jev_judge_user_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jev_judge_global_usage ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies: only the server role (service role bypasses RLS) touches these.

-- Atomic check-and-consume: locks the global day row and the user day row, checks both
-- limits, increments both only when allowed. Called with the handler's env-configured
-- limits so env stays the single source of truth.
CREATE OR REPLACE FUNCTION public.consume_jev_judge_usage(
  p_user_id TEXT,
  p_day DATE,
  p_est_cost_usd NUMERIC,
  p_user_call_limit BIGINT DEFAULT 500,
  p_global_cost_limit_usd NUMERIC DEFAULT 1.0
)
RETURNS TABLE (allowed BOOLEAN, reason TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_calls BIGINT;
  v_global_cost NUMERIC;
BEGIN
  -- Ensure both day rows exist, then lock them FOR UPDATE so concurrent callers
  -- serialize on check+increment (no over-admission past either limit).
  INSERT INTO public.jev_judge_global_usage (day, calls, est_cost_usd)
  VALUES (p_day, 0, 0)
  ON CONFLICT (day) DO NOTHING;

  SELECT est_cost_usd INTO v_global_cost
  FROM public.jev_judge_global_usage
  WHERE day = p_day
  FOR UPDATE;

  INSERT INTO public.jev_judge_user_usage (user_id, day, calls, est_cost_usd)
  VALUES (p_user_id, p_day, 0, 0)
  ON CONFLICT (user_id, day) DO NOTHING;

  SELECT calls INTO v_user_calls
  FROM public.jev_judge_user_usage
  WHERE user_id = p_user_id AND day = p_day
  FOR UPDATE;

  IF v_user_calls >= p_user_call_limit THEN
    RETURN QUERY SELECT FALSE, 'user_daily_limit'::TEXT;
    RETURN;
  END IF;

  IF v_global_cost + p_est_cost_usd > p_global_cost_limit_usd THEN
    RETURN QUERY SELECT FALSE, 'global_fuse'::TEXT;
    RETURN;
  END IF;

  UPDATE public.jev_judge_global_usage
  SET calls = calls + 1,
      est_cost_usd = est_cost_usd + p_est_cost_usd,
      updated_at = NOW()
  WHERE day = p_day;

  UPDATE public.jev_judge_user_usage
  SET calls = calls + 1,
      est_cost_usd = est_cost_usd + p_est_cost_usd,
      updated_at = NOW()
  WHERE user_id = p_user_id AND day = p_day;

  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;

-- Read-only daily rollup for the admin dashboard (no new UI in this ticket).
-- security_invoker keeps RLS of the underlying tables in force for non-privileged roles.
CREATE OR REPLACE VIEW public.jev_judge_daily_usage
WITH (security_invoker = on)
AS
SELECT
  g.day,
  g.calls AS total_calls,
  g.est_cost_usd AS total_est_cost_usd,
  count(u.user_id) AS active_users
FROM public.jev_judge_global_usage g
LEFT JOIN public.jev_judge_user_usage u ON u.day = g.day
GROUP BY g.day, g.calls, g.est_cost_usd;
