-- ============================================================================
-- Admin RPC: toggle user admin role
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_set_user_admin(
  p_user_id UUID,
  p_is_admin BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.require_code_agent_admin();

  IF p_user_id = auth.uid() AND p_is_admin = FALSE THEN
    RAISE EXCEPTION 'Cannot revoke your own admin role' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET
    is_admin = p_is_admin,
    updated_at = NOW()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO public.profiles (
      id,
      is_admin,
      created_at,
      updated_at
    )
    VALUES (
      p_user_id,
      p_is_admin,
      NOW(),
      NOW()
    );
  END IF;
END;
$$;
