-- ============================================================================
-- Collaboration spaces: cloud project shell, membership, and invite redemption
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.collab_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.project_members (
  project_id UUID NOT NULL REFERENCES public.collab_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  display_name TEXT,
  avatar_url TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_members_project_user_unique UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.project_invites (
  code TEXT PRIMARY KEY CHECK (length(code) >= 22),
  project_id UUID NOT NULL REFERENCES public.collab_projects(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_members_user
  ON public.project_members(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_project_invites_project
  ON public.project_invites(project_id);

ALTER TABLE public.collab_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_invites ENABLE ROW LEVEL SECURITY;

-- RLS helper: authenticated callers may ask only whether their own uid belongs to a project.
CREATE OR REPLACE FUNCTION public.is_collab_project_member(
  p_project_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_members AS member
    WHERE member.project_id = p_project_id
      AND member.user_id = auth.uid()
  );
$$;

-- RLS helper: ownership is anchored on collab_projects.owner_user_id, never on client claims.
CREATE OR REPLACE FUNCTION public.is_collab_project_owner(
  p_project_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.collab_projects AS project
    WHERE project.id = p_project_id
      AND project.owner_user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_collab_project_member(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_collab_project_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_collab_project_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_collab_project_owner(UUID) TO authenticated;

-- 放行项目成员读取项目壳；拦截非成员枚举项目。
CREATE POLICY "Project members read project shells" ON public.collab_projects
  FOR SELECT TO authenticated
  USING (public.is_collab_project_member(id));

-- 放行登录用户创建归属自己的项目；拦截代他人建 owner 项目。
CREATE POLICY "Users create own project shells" ON public.collab_projects
  FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

-- 放行 owner 修改自己的项目壳；拦截普通成员改项目。
CREATE POLICY "Owners update project shells" ON public.collab_projects
  FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- 放行 owner 删除自己的项目壳；拦截普通成员删项目。
CREATE POLICY "Owners delete project shells" ON public.collab_projects
  FOR DELETE TO authenticated
  USING (owner_user_id = auth.uid());

-- 放行项目成员读取同项目成员卡；拦截跨项目枚举成员。
CREATE POLICY "Project members read member cards" ON public.project_members
  FOR SELECT TO authenticated
  USING (public.is_collab_project_member(project_id));

-- 放行 owner 添加成员；拦截普通成员绕过邀请码加人。
CREATE POLICY "Owners insert project members" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_collab_project_owner(project_id));

-- 放行 owner 移除成员；拦截普通成员删除成员关系。
CREATE POLICY "Owners delete project members" ON public.project_members
  FOR DELETE TO authenticated
  USING (public.is_collab_project_owner(project_id));

-- 放行 owner 创建邀请码；拦截普通成员发码。
CREATE POLICY "Owners create project invites" ON public.project_invites
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.is_collab_project_owner(project_id)
  );

-- 放行 owner 更新邀请码状态；拦截普通成员撤销或改额度。
CREATE POLICY "Owners update project invites" ON public.project_invites
  FOR UPDATE TO authenticated
  USING (public.is_collab_project_owner(project_id))
  WITH CHECK (public.is_collab_project_owner(project_id));

-- 放行 owner 删除邀请码；拦截普通成员删码。
CREATE POLICY "Owners delete project invites" ON public.project_invites
  FOR DELETE TO authenticated
  USING (public.is_collab_project_owner(project_id));

CREATE OR REPLACE FUNCTION public.redeem_project_invite(code TEXT)
RETURNS TABLE (
  collab_project_id UUID,
  project_name TEXT,
  member_role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_code TEXT := btrim(code);
  v_invite public.project_invites%ROWTYPE;
  v_inserted INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COLLAB_AUTH_REQUIRED';
  END IF;

  SELECT invite.*
  INTO v_invite
  FROM public.project_invites AS invite
  WHERE invite.code = v_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLAB_INVITE_NOT_FOUND';
  END IF;
  IF v_invite.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLAB_INVITE_REVOKED';
  END IF;
  IF v_invite.expires_at <= NOW() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLAB_INVITE_EXPIRED';
  END IF;
  IF v_invite.used_count >= v_invite.max_uses THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLAB_INVITE_EXHAUSTED';
  END IF;

  INSERT INTO public.project_members (
    project_id,
    user_id,
    role,
    display_name,
    avatar_url
  )
  SELECT
    v_invite.project_id,
    v_user_id,
    'member',
    COALESCE(profile.nickname, profile.username, account.email, '成员'),
    profile.avatar_url
  FROM auth.users AS account
  LEFT JOIN public.profiles AS profile ON profile.id = account.id
  WHERE account.id = v_user_id
  ON CONFLICT (project_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted > 0 THEN
    UPDATE public.project_invites AS invite
    SET used_count = invite.used_count + 1
    WHERE invite.code = v_code;
  END IF;

  RETURN QUERY
  SELECT project.id, project.name, member.role
  FROM public.collab_projects AS project
  JOIN public.project_members AS member
    ON member.project_id = project.id
   AND member.user_id = v_user_id
  WHERE project.id = v_invite.project_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_project_invite(code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_code TEXT := btrim(code);
  v_project_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COLLAB_AUTH_REQUIRED';
  END IF;

  SELECT invite.project_id
  INTO v_project_id
  FROM public.project_invites AS invite
  WHERE invite.code = v_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLAB_INVITE_NOT_FOUND';
  END IF;
  IF NOT public.is_collab_project_owner(v_project_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COLLAB_FORBIDDEN';
  END IF;

  UPDATE public.project_invites AS invite
  SET revoked_at = COALESCE(invite.revoked_at, NOW())
  WHERE invite.code = v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_project_invite(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_project_invite(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_project_invite(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_project_invite(TEXT) TO authenticated;
