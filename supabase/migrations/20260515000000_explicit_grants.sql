-- ============================================================================
-- Explicit Grants Migration
-- ============================================================================
-- 背景: 2026-05-30 起 Supabase 新项目不再默认把 public schema 暴露给 Data API；
-- 2026-10-30 起对所有存量项目生效。届时新建的 public 表若无显式 GRANT，
-- 通过 supabase-js / PostgREST 访问会返回 42501。
--
-- 本迁移做两件事:
--   1. 给现有 public 表补上显式 GRANT，确保存量表在强制生效后继续可访问
--   2. 设置 default privileges，让未来新建的 public 表自动获得同样授权
--      —— 行级安全(RLS)仍是真正的数据访问闸门，各表已 enable RLS + policy
-- ============================================================================

-- schema 使用权限
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 现有所有表 / 序列 / 函数的显式授权
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

-- 未来新建对象的默认授权 (恢复 Supabase 改版前的默认行为)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
