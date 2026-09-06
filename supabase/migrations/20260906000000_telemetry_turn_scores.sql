-- ============================================================================
-- 上线后评分上云（ADR-063 §6.3 · N-EVAL-POSTLAUNCH-K3）
-- ============================================================================
-- 一行 = 一轮真实会话的质量判决：六维 0/1、失败类别、≤200 字脱敏后的一行理由、
-- 信号名、judge 版本、成本。**没有 prompt / 回复 / 工具入参出参**——正文永远留在
-- 用户本机的 telemetry_turns / telemetry_raw_payloads 里不出机器（ADR-040「元数据」档）。
--
-- 本文件三件事，全是纯新增，不改不删任何现有表 / 列 / 策略：
--   1. telemetry_sessions 补 origin_kind 列（K2 在本机落了这个标记，云端还没有这一列）
--   2. 新表 telemetry_turn_scores + RLS 四条（抄遥测五表形态）
--   3. 聚合视图 admin_postlaunch_quality（security_invoker=on，可见性完全由底表 RLS 决定）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) telemetry_sessions.origin_kind —— 会话是谁起的
-- ----------------------------------------------------------------------------
-- headless = 脚本 / neo CLI / 评测真跑桥起的会话。它们的 session_type 也是 'chat'，
-- 从 session_type 一个字都看不出来，不剔就会把探针算进上线后分母（ADR-063 §3）。
-- 存量行是 NULL，靠下面视图里的 cli_session_ 前缀过渡判据兜底。
-- ponytail: 不建 origin_kind 索引——视图里的判据是
-- 「COALESCE(origin_kind,'')='' 时看 id 前缀，否则 <> 'headless'」，不是 sargable 条件，
-- 索引扫不到；真到了要按来源切片的量级再补。
ALTER TABLE public.telemetry_sessions ADD COLUMN IF NOT EXISTS origin_kind TEXT;

-- ----------------------------------------------------------------------------
-- 2) telemetry_turn_scores —— 分数元数据
-- ----------------------------------------------------------------------------
-- 与本机 telemetry_turn_scores（schemaTelemetry.ts）同名同轮，但**故意少两列**：
--   - prompt_hash：本机用来判「这一轮已经评过没有」的去重键，云端不做去重也不复评，传了没人用；
--   - budget_cost_usd：本机日预算账本（未知刊例时按保守默认价估），是「花没花超」的本地账，
--     不是云端要看的真实成本。云端只看 cost_usd（刊例估算，未知价按 0，不编造）。
-- 宁少勿多：上传的每一列都要能在 ADR-063 §1 的清单里指到。
CREATE TABLE IF NOT EXISTS public.telemetry_turn_scores (
  turn_id              TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES public.telemetry_sessions(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id            TEXT,
  app_version          TEXT,
  prompt_version       TEXT,
  scored_at            BIGINT,      -- 客户端毫秒时间戳
  scored_day           TEXT,        -- 客户端本地日历日 YYYY-MM-DD（日预算按它切）
  turn_started_at      BIGINT,      -- 这一轮开始的时间，报告按它切周
  judge_version        TEXT NOT NULL,
  rubric_version       TEXT NOT NULL,
  judge_model          TEXT,        -- 含哨兵 'unavailable' / 'not-judged'
  -- 六维：1=通过 0=不通过 NULL=无判决（judge 不可用或证据不足）。NULL 不进分母。
  dim_goal             SMALLINT,
  dim_orchestration    SMALLINT,
  dim_tools            SMALLINT,
  dim_permission       SMALLINT,
  dim_safety           SMALLINT,
  dim_artifact         SMALLINT,
  failure_class        TEXT,
  reason_redacted      TEXT,        -- ≤200 字，已过 guardSensitiveText；命中脱敏则为空串
  redacted             BOOLEAN,
  signals              JSONB,       -- 信号**名**数组，不含工具入参出参原文
  cost_usd             NUMERIC,
  sampled_by           TEXT NOT NULL,  -- 'signal' | 'sample'，两类不合并统计
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.telemetry_turn_scores ENABLE ROW LEVEL SECURITY;

-- insert / update own：与 telemetry_turns 同形，除了 auth.uid() 还要求这条会话确实是自己的
-- （owns_telemetry_session 是 SECURITY DEFINER，绕开 RLS 只查归属）。
DROP POLICY IF EXISTS "Users insert own turn scores" ON public.telemetry_turn_scores;
CREATE POLICY "Users insert own turn scores" ON public.telemetry_turn_scores
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.owns_telemetry_session(session_id)
  );

DROP POLICY IF EXISTS "Users update own turn scores" ON public.telemetry_turn_scores;
CREATE POLICY "Users update own turn scores" ON public.telemetry_turn_scores
  FOR UPDATE USING (
    auth.uid() = user_id
    AND public.owns_telemetry_session(session_id)
  ) WITH CHECK (
    auth.uid() = user_id
    AND public.owns_telemetry_session(session_id)
  );

-- select own 不是可选项：客户端走 upsert(onConflict: 'turn_id')，PostgREST 生成
-- INSERT ... ON CONFLICT DO UPDATE，Postgres 解析冲突目标时要对发起角色做 SELECT 可见性判断。
-- 缺这条策略 ⇒ 无论 user_id 对不对，整条语句 42501 被拒
-- （20260808000000_telemetry_own_row_select.sql 里的沙箱实测结论，五张表全中过这一枪）。
DROP POLICY IF EXISTS "Users select own turn scores" ON public.telemetry_turn_scores;
CREATE POLICY "Users select own turn scores" ON public.telemetry_turn_scores
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all turn scores" ON public.telemetry_turn_scores;
CREATE POLICY "Admins read all turn scores" ON public.telemetry_turn_scores
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_turn_scores_user_day
  ON public.telemetry_turn_scores(user_id, scored_day);
CREATE INDEX IF NOT EXISTS idx_turn_scores_version_day
  ON public.telemetry_turn_scores(app_version, scored_day);
CREATE INDEX IF NOT EXISTS idx_turn_scores_session
  ON public.telemetry_turn_scores(session_id);

-- ----------------------------------------------------------------------------
-- 3) admin_postlaunch_quality —— 周 × 天 × 版本 × 用户 × 采样来源的过率
-- ----------------------------------------------------------------------------
-- security_invoker=on ⇒ 可见性就是底表 telemetry_turn_scores 的 RLS：admin 看全部，
-- 普通用户看得见**自己那几行**（2026-08-08 加 select own 之后就是这样，读回的是他本来
-- 就存在自己机器上的那份数据，不是跨用户泄露）。控制台不靠这层挡人——middleware 的
-- is_code_agent_admin() 已经把非 admin 拦在页面外。
-- 本地沙箱实测：alice 在视图里看到自己 1 行、别人 0 行；admin（自己零数据）看到 2 行。
-- WHERE 段与本机 isPostLaunchScorableSession（src/shared/contract/postLaunchScore.ts:89）
-- **字面对齐**，一处判两处用。TS 那边逐行是：
--   if (!isScorableSessionType(session.sessionType)) return false;   // 空 session_type 按 chat 算，进分母
--   if (session.originKind) return session.originKind !== 'headless'; // 注意 '' 在 JS 里是假值
--   return !session.id.startsWith('cli_session_');                    // 存量行过渡判据
-- 所以 SQL 里 origin_kind 的空串必须和 NULL 一样落到前缀判据上（COALESCE(...,'') <> ''），
-- 否则同一条会话两边算出不同的分母。
-- 先 DROP 再 CREATE，不用 CREATE OR REPLACE：后者不允许改列顺序或在中间插列
-- （`cannot change name of view column "user_id" to "judge_version"`，本地沙箱实测）。
-- 这张视图以后还要加维度，用 DROP + CREATE 才是真幂等。
-- 视图上没有自己的 policy（security_invoker 直接用底表 RLS），重建不会丢策略；
-- 表级 GRANT 由 20260515000000_explicit_grants.sql 的 ALTER DEFAULT PRIVILEGES 自动补回。
DROP VIEW IF EXISTS public.admin_postlaunch_quality;
CREATE VIEW public.admin_postlaunch_quality
WITH (security_invoker = true) AS
--
-- 粒度是**天**，不是周：周块（首页「近 4 周 × 版本」）和「近 7 天」（用户页那一列）
-- 都要从同一份数字上卷出来，否则两处会各自算一遍分母、迟早对不上。
-- week_start 仍然直接给出来，页面按周分组不用再做日期运算。
WITH scorable AS (
  SELECT
    date_trunc('week', to_timestamp(sc.turn_started_at / 1000.0))            AS week_start,
    date_trunc('day', to_timestamp(sc.turn_started_at / 1000.0))             AS day_start,
    sc.app_version,
    sc.prompt_version,
    sc.judge_version,
    sc.rubric_version,
    sc.scored_at,
    sc.user_id,
    sc.sampled_by,
    sc.dim_goal, sc.dim_orchestration, sc.dim_tools,
    sc.dim_permission, sc.dim_safety, sc.dim_artifact,
    sc.failure_class,
    sc.cost_usd,
    sc.judge_model,
    sc.session_id
  FROM public.telemetry_turn_scores sc
  JOIN public.telemetry_sessions s ON s.id = sc.session_id
  -- CLI --dry-run 的演练行（judge_version='dry-run'）不进正式分母：它没真叫过打分模型，
  -- 本机正式报告也是按 judge_version 筛掉它的（buildPostLaunchReport 默认只读
  -- POST_LAUNCH_JUDGE_VERSION）。云端同口径，两边不会一个算一个不算。
  -- 上传器那边也不传这类行，这里是第二道：旧版客户端传上来的照样不该进统计。
  WHERE sc.judge_version <> 'dry-run'
    AND (s.session_type IS NULL
         OR s.session_type NOT IN ('eval', 'subagent', 'schedule', 'heartbeat'))
    AND (CASE WHEN COALESCE(s.origin_kind, '') <> ''
              THEN s.origin_kind <> 'headless'
              ELSE s.id NOT LIKE 'cli\_session\_%'
         END)
)
SELECT
  week_start,
  day_start,
  app_version,
  prompt_version,
  -- judge / rubric 版本进分组键：换了打分提示词或口径，分数不可跨版本相比（ADR-063 §2）。
  -- 不分组就会把两版判决合成一个过率，看着连续其实是两把尺子量出来的。
  judge_version,
  rubric_version,
  user_id,
  sampled_by,
  -- 口径新旧的确定排序键：同一天可能同时有两版 judge/rubric 的行，只比天会靠返回顺序定胜负。
  max(scored_at)::bigint                           AS last_scored_at,
  count(*)::int                                    AS turns,
  count(DISTINCT session_id)::int                  AS sessions,
  -- 六维各自「有判决的轮数 / 判过的轮数」：NULL 不进分母，所以 count(col) 就是分母。
  count(dim_goal)::int                             AS goal_judged,
  COALESCE(sum(dim_goal), 0)::int                  AS goal_passed,
  count(dim_orchestration)::int                    AS orchestration_judged,
  COALESCE(sum(dim_orchestration), 0)::int         AS orchestration_passed,
  count(dim_tools)::int                            AS tools_judged,
  COALESCE(sum(dim_tools), 0)::int                 AS tools_passed,
  count(dim_permission)::int                       AS permission_judged,
  COALESCE(sum(dim_permission), 0)::int            AS permission_passed,
  count(dim_safety)::int                           AS safety_judged,
  COALESCE(sum(dim_safety), 0)::int                AS safety_passed,
  count(dim_artifact)::int                         AS artifact_judged,
  COALESCE(sum(dim_artifact), 0)::int              AS artifact_passed,
  count(*) FILTER (WHERE judge_model = 'unavailable')::int AS judge_unavailable_turns,
  COALESCE(sum(cost_usd), 0)::numeric              AS cost_usd,
  COALESCE((
    SELECT jsonb_object_agg(f.code, f.n)
    FROM (
      SELECT code, count(*) AS n
      FROM unnest(array_agg(failure_class) FILTER (WHERE failure_class IS NOT NULL)) AS code
      GROUP BY code
    ) f
  ), '{}'::jsonb)                                  AS failure_classes
FROM scorable
GROUP BY week_start, day_start, app_version, prompt_version, judge_version, rubric_version, user_id, sampled_by;
