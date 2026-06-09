-- Shared service API keys (search, etc.) for control-plane cloud_config delivery.
-- The table stores only api_key_env; real keys remain in Vercel env and are injected server-side.

CREATE TABLE IF NOT EXISTS public.control_plane_shared_service_keys (
  service TEXT PRIMARY KEY,
  display_name TEXT,
  base_url TEXT,
  api_key_env TEXT NOT NULL,
  required_capability TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  disabled_reason TEXT,
  disabled_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_plane_shared_service_keys_service_check
    CHECK (service IN ('brave', 'exa', 'openai', 'perplexity', 'tavily'))
);

ALTER TABLE public.control_plane_shared_service_keys
  ADD COLUMN IF NOT EXISTS base_url TEXT;

ALTER TABLE public.control_plane_shared_service_keys
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

ALTER TABLE public.control_plane_shared_service_keys
  ADD COLUMN IF NOT EXISTS disabled_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

ALTER TABLE public.control_plane_shared_service_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage shared service keys" ON public.control_plane_shared_service_keys;
CREATE POLICY "Admins can manage shared service keys" ON public.control_plane_shared_service_keys
  FOR ALL
  USING (public.is_code_agent_admin())
  WITH CHECK (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_control_plane_shared_service_keys_enabled
  ON public.control_plane_shared_service_keys(enabled);

CREATE TABLE IF NOT EXISTS public.control_plane_shared_service_key_pool_state (
  service TEXT NOT NULL,
  key_id TEXT NOT NULL,
  disabled_reason TEXT,
  disabled_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (service, key_id),
  CONSTRAINT control_plane_shared_service_key_pool_state_service_check
    CHECK (service IN ('brave', 'exa', 'openai', 'perplexity', 'tavily'))
);

ALTER TABLE public.control_plane_shared_service_key_pool_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage shared service key pool state" ON public.control_plane_shared_service_key_pool_state;
CREATE POLICY "Admins can manage shared service key pool state" ON public.control_plane_shared_service_key_pool_state
  FOR ALL
  USING (public.is_code_agent_admin())
  WITH CHECK (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_control_plane_shared_service_key_pool_state_service
  ON public.control_plane_shared_service_key_pool_state(service);

CREATE INDEX IF NOT EXISTS idx_control_plane_shared_service_key_pool_state_disabled_until
  ON public.control_plane_shared_service_key_pool_state(disabled_until);

DROP TRIGGER IF EXISTS trg_touch_shared_service_keys_updated_at
  ON public.control_plane_shared_service_keys;
CREATE TRIGGER trg_touch_shared_service_keys_updated_at
  BEFORE UPDATE ON public.control_plane_shared_service_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_shared_service_key_pool_state_updated_at
  ON public.control_plane_shared_service_key_pool_state;
CREATE TRIGGER trg_touch_shared_service_key_pool_state_updated_at
  BEFORE UPDATE ON public.control_plane_shared_service_key_pool_state
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();
