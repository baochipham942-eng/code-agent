-- ============================================================================
-- Control-plane governance: entitlement rollout + audit ledger
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.control_plane_entitlements (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'revoked'
    CHECK (status IN ('active', 'trial', 'expired', 'revoked')),
  plan TEXT NOT NULL DEFAULT 'free',
  capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.control_plane_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage control-plane entitlements" ON public.control_plane_entitlements;
CREATE POLICY "Admins can manage control-plane entitlements" ON public.control_plane_entitlements
  FOR ALL USING (public.is_code_agent_admin())
  WITH CHECK (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_control_plane_entitlements_status
  ON public.control_plane_entitlements(status);

CREATE TABLE IF NOT EXISTS public.control_plane_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN ('cloud_config', 'capability_registry', 'prompt_registry', 'update_manifest')
  ),
  payload_version TEXT,
  release_channel TEXT CHECK (release_channel IS NULL OR release_channel IN ('stable', 'beta', 'canary')),
  key_id TEXT,
  content_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('served', 'not_modified', 'head', 'error')),
  status_code INTEGER NOT NULL,
  error_code TEXT,
  request_id TEXT,
  request_method TEXT,
  user_agent TEXT,
  subject_id TEXT,
  subject_source TEXT,
  entitlement_status TEXT,
  entitlement_plan TEXT,
  entitlement_reason TEXT
);

ALTER TABLE public.control_plane_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view control-plane audit events" ON public.control_plane_audit_events;
CREATE POLICY "Admins can view control-plane audit events" ON public.control_plane_audit_events
  FOR SELECT USING (public.is_code_agent_admin());

CREATE INDEX IF NOT EXISTS idx_control_plane_audit_events_created_at
  ON public.control_plane_audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_control_plane_audit_events_artifact_created
  ON public.control_plane_audit_events(artifact_kind, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_control_plane_entitlement_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_control_plane_entitlement_updated_at
  ON public.control_plane_entitlements;
CREATE TRIGGER trg_touch_control_plane_entitlement_updated_at
  BEFORE UPDATE ON public.control_plane_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_control_plane_entitlement_updated_at();

CREATE OR REPLACE FUNCTION public.admin_list_control_plane_audit_events(
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  artifact_kind TEXT,
  payload_version TEXT,
  release_channel TEXT,
  key_id TEXT,
  content_hash TEXT,
  outcome TEXT,
  status_code INTEGER,
  error_code TEXT,
  subject_id TEXT,
  subject_source TEXT,
  entitlement_status TEXT,
  entitlement_plan TEXT,
  entitlement_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.require_code_agent_admin();

  RETURN QUERY
  SELECT
    event.id,
    event.created_at,
    event.artifact_kind,
    event.payload_version,
    event.release_channel,
    event.key_id,
    event.content_hash,
    event.outcome,
    event.status_code,
    event.error_code,
    event.subject_id,
    event.subject_source,
    event.entitlement_status,
    event.entitlement_plan,
    event.entitlement_reason
  FROM public.control_plane_audit_events event
  ORDER BY event.created_at DESC
  LIMIT GREATEST(LEAST(COALESCE(p_limit, 50), 200), 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_control_plane_rollout_summary()
RETURNS TABLE (
  artifact_kind TEXT,
  payload_version TEXT,
  release_channel TEXT,
  key_id TEXT,
  content_hash TEXT,
  last_seen_at TIMESTAMPTZ,
  served_count BIGINT,
  error_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.require_code_agent_admin();

  RETURN QUERY
  SELECT
    event.artifact_kind,
    event.payload_version,
    event.release_channel,
    event.key_id,
    event.content_hash,
    MAX(event.created_at) AS last_seen_at,
    COUNT(*) FILTER (WHERE event.outcome IN ('served', 'head', 'not_modified'))::BIGINT AS served_count,
    COUNT(*) FILTER (WHERE event.outcome = 'error')::BIGINT AS error_count
  FROM public.control_plane_audit_events event
  GROUP BY
    event.artifact_kind,
    event.payload_version,
    event.release_channel,
    event.key_id,
    event.content_hash
  ORDER BY MAX(event.created_at) DESC;
END;
$$;
