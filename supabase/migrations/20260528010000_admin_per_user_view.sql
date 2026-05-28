-- ============================================================================
-- admin_per_user_telemetry view — per-user 聚合（admin 控制台 /users 页用）
-- ============================================================================
-- 仅 admin 可读（security_invoker=on 让 view 走 telemetry_sessions 的 admin-only RLS）。
-- 不创建额外 policy；underlying 表的 admin-only SELECT 自动生效。
-- ============================================================================

CREATE OR REPLACE VIEW public.admin_per_user_telemetry
WITH (security_invoker = true) AS
SELECT
  user_id,
  count(*)::int                                      AS sessions,
  count(*) FILTER (WHERE status = 'error')::int      AS errors,
  COALESCE(sum(total_tokens), 0)::bigint             AS total_tokens,
  COALESCE(sum(estimated_cost), 0)::numeric          AS total_cost,
  COALESCE(sum(total_tool_calls), 0)::bigint         AS total_tool_calls,
  max(uploaded_at)                                   AS last_seen,
  min(uploaded_at)                                   AS first_seen
FROM public.telemetry_sessions
WHERE user_id IS NOT NULL
GROUP BY user_id;
