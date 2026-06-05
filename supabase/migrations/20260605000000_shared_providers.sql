-- ============================================================================
-- 团队共享 provider（中转站）配置表
-- 混合方案：key 留 Vercel env（零客户端可达面），这张表只放「会变的配置」——
-- 模型白名单 / 开关 / 端点 / 授权门 / key 所在的 env 变量名。改这些零部署。
-- 安全：admin-only RLS（照抄 control_plane_entitlements 模板）。控制面服务端走 service role 读，
-- 绕过 RLS；admin 控制台走管理员 cookie 会话受 RLS 约束；anon/普通 authenticated 一律拒。
-- api_key 绝不入库——只存 env 变量名（api_key_env），真值由控制面在 Vercel env 里取。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.control_plane_shared_providers (
  id TEXT PRIMARY KEY,                          -- 必须是动态 custom provider 形态 custom-xxx
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai', 'claude')),
  billing_mode TEXT NOT NULL DEFAULT 'unknown'
    CHECK (billing_mode IN ('free', 'plan', 'payg', 'unknown')),
  models JSONB NOT NULL DEFAULT '[]'::JSONB,    -- [{ "id": "gpt-5.5", "label": "..." }]
  required_capability TEXT,                     -- NULL=team-wide（所有登录用户）；非空=仅命中该 capability
  api_key_env TEXT NOT NULL,                    -- 持有该 provider key 的 Vercel env 变量名（不是 key 本身）
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.control_plane_shared_providers ENABLE ROW LEVEL SECURITY;

-- admin-only：anon / 非管理员 authenticated 读写一律拒（控制面走 service role 绕过 RLS）
DROP POLICY IF EXISTS "Admins can manage shared providers" ON public.control_plane_shared_providers;
CREATE POLICY "Admins can manage shared providers" ON public.control_plane_shared_providers
  FOR ALL USING (public.is_code_agent_admin())
  WITH CHECK (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_control_plane_shared_providers_enabled
  ON public.control_plane_shared_providers(enabled);

-- updated_at 触发器（复用 entitlements 同款函数）
DROP TRIGGER IF EXISTS trg_touch_shared_providers_updated_at
  ON public.control_plane_shared_providers;
CREATE TRIGGER trg_touch_shared_providers_updated_at
  BEFORE UPDATE ON public.control_plane_shared_providers
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_control_plane_entitlement_updated_at();
