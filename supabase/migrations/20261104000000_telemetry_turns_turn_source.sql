-- ============================================================================
-- telemetry_turns 补 turn_source 列：云端 schema 追上客户端上传行
-- ============================================================================
-- 客户端上传行（src/host/telemetry/telemetryUploadRow.ts）已携带 turn_source
-- （委托/spawn 来源标记，'delegation'），但 telemetry_turns 建表迁移
-- （20260528000000_telemetry_fleet.sql）没有这一列：每轮 turn 上传都被
-- PGRST204（schema cache 找不到列）整批拒绝，委托来源的 turn 遥测一直上不了云。
--
-- 幂等纯增量：nullable TEXT，无默认值、无回填、不动既有行；
-- 随后显式刷新 PostgREST schema cache，让 PGRST204 立即消失，不必等自然 reload。
-- 客户端另有降级护栏（PGRST204 命中可选列白名单时去列重试一次），
-- 本迁移修云端根因；两者合起来把「云端 schema 滞后于 app」的窗口期损失清零。

ALTER TABLE public.telemetry_turns ADD COLUMN IF NOT EXISTS turn_source TEXT;

NOTIFY pgrst, 'reload schema';
