-- ============================================================================
-- User dashboard + invite code management
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  ADD COLUMN IF NOT EXISTS signup_source TEXT,
  ADD COLUMN IF NOT EXISTS invite_code TEXT,
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_status
  ON public.profiles(status);

CREATE INDEX IF NOT EXISTS idx_profiles_invite_code
  ON public.profiles(invite_code)
  WHERE invite_code IS NOT NULL;

ALTER TABLE public.invite_codes
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invite_codes_created_at
  ON public.invite_codes(created_at DESC);

CREATE OR REPLACE FUNCTION public.is_code_agent_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE((
    SELECT p.is_admin
    FROM public.profiles p
    WHERE p.id = auth.uid()
    LIMIT 1
  ), FALSE);
$$;

CREATE OR REPLACE FUNCTION public.require_code_agent_admin()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.is_code_agent_admin() THEN
    RAISE EXCEPTION 'Admin permission required' USING ERRCODE = '42501';
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
CREATE POLICY "Admins can view all profiles" ON public.profiles
  FOR SELECT USING (public.is_code_agent_admin());

DROP POLICY IF EXISTS "Admins can manage invite codes" ON public.invite_codes;
CREATE POLICY "Admins can manage invite codes" ON public.invite_codes
  FOR ALL USING (public.is_code_agent_admin())
  WITH CHECK (public.is_code_agent_admin());

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id UUID,
  email TEXT,
  username TEXT,
  nickname TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN,
  status TEXT,
  signup_source TEXT,
  invite_code TEXT,
  provider TEXT,
  created_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_session_updated_at BIGINT,
  device_count BIGINT,
  session_count BIGINT,
  message_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.require_code_agent_admin();

  RETURN QUERY
  WITH device_rollup AS (
    SELECT
      d.user_id,
      COUNT(*)::BIGINT AS device_count,
      MAX(d.last_active_at) AS last_device_active_at
    FROM public.devices d
    GROUP BY d.user_id
  ),
  session_rollup AS (
    SELECT
      s.user_id,
      COUNT(*)::BIGINT AS session_count,
      MAX(s.updated_at)::BIGINT AS last_session_updated_at
    FROM public.sessions s
    WHERE COALESCE(s.is_deleted, FALSE) = FALSE
    GROUP BY s.user_id
  ),
  message_rollup AS (
    SELECT
      m.user_id,
      COUNT(*)::BIGINT AS message_count
    FROM public.messages m
    WHERE COALESCE(m.is_deleted, FALSE) = FALSE
    GROUP BY m.user_id
  )
  SELECT
    au.id,
    au.email::TEXT,
    p.username,
    p.nickname,
    p.avatar_url,
    COALESCE(p.is_admin, FALSE) AS is_admin,
    COALESCE(p.status, 'active') AS status,
    p.signup_source,
    p.invite_code,
    au.raw_app_meta_data->>'provider' AS provider,
    COALESCE(p.created_at, au.created_at) AS created_at,
    au.last_sign_in_at,
    NULLIF(
      GREATEST(
        COALESCE(p.last_active_at, 'epoch'::TIMESTAMPTZ),
        COALESCE(p.last_sync_at, 'epoch'::TIMESTAMPTZ),
        COALESCE(dr.last_device_active_at, 'epoch'::TIMESTAMPTZ)
      ),
      'epoch'::TIMESTAMPTZ
    ) AS last_active_at,
    p.last_sync_at,
    sr.last_session_updated_at,
    COALESCE(dr.device_count, 0) AS device_count,
    COALESCE(sr.session_count, 0) AS session_count,
    COALESCE(mr.message_count, 0) AS message_count
  FROM auth.users au
  LEFT JOIN public.profiles p ON p.id = au.id
  LEFT JOIN device_rollup dr ON dr.user_id = au.id
  LEFT JOIN session_rollup sr ON sr.user_id = au.id
  LEFT JOIN message_rollup mr ON mr.user_id = au.id
  ORDER BY COALESCE(p.created_at, au.created_at) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_invite_codes()
RETURNS TABLE (
  id UUID,
  code TEXT,
  label TEXT,
  max_uses INTEGER,
  use_count INTEGER,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by UUID,
  created_by_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.require_code_agent_admin();

  RETURN QUERY
  SELECT
    ic.id,
    ic.code,
    ic.label,
    ic.max_uses,
    ic.use_count,
    ic.expires_at,
    ic.is_active,
    ic.created_at,
    ic.updated_at,
    ic.last_used_at,
    ic.created_by,
    au.email::TEXT AS created_by_email
  FROM public.invite_codes ic
  LEFT JOIN auth.users au ON au.id = ic.created_by
  ORDER BY ic.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_invite_code(
  p_code TEXT,
  p_max_uses INTEGER DEFAULT 1,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_label TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_id UUID;
  v_code TEXT;
BEGIN
  PERFORM public.require_code_agent_admin();

  v_code := UPPER(TRIM(p_code));
  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Invite code is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invite_codes (
    code,
    label,
    max_uses,
    expires_at,
    is_active,
    created_by,
    updated_at
  )
  VALUES (
    v_code,
    NULLIF(TRIM(p_label), ''),
    GREATEST(COALESCE(p_max_uses, 1), 1),
    p_expires_at,
    TRUE,
    auth.uid(),
    NOW()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_invite_code(
  p_id UUID,
  p_label TEXT DEFAULT NULL,
  p_max_uses INTEGER DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.require_code_agent_admin();

  UPDATE public.invite_codes
  SET
    label = NULLIF(TRIM(COALESCE(p_label, label)), ''),
    max_uses = CASE
      WHEN p_max_uses IS NULL THEN max_uses
      ELSE GREATEST(p_max_uses, 1)
    END,
    expires_at = p_expires_at,
    is_active = COALESCE(p_is_active, is_active),
    updated_at = NOW()
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_invite_code_usage(code_value TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE public.invite_codes
  SET
    use_count = use_count + 1,
    last_used_at = NOW(),
    updated_at = NOW()
  WHERE code = UPPER(TRIM(code_value));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
