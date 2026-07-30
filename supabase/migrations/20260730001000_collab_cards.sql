-- ============================================================================
-- Collaboration cards: member-visible metadata, source-owned mutations
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.collab_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.collab_projects(id) ON DELETE CASCADE,
  source_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_card_id TEXT NOT NULL CHECK (length(btrim(local_card_id)) > 0),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  requester_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT collab_cards_project_source_local_unique
    UNIQUE (project_id, source_user_id, local_card_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_cards_project_updated
  ON public.collab_cards(project_id, updated_at DESC);

ALTER TABLE public.collab_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Project members read collaboration cards" ON public.collab_cards;
-- 放行项目成员读取本项目卡元数据；拦截非成员及跨项目枚举。
CREATE POLICY "Project members read collaboration cards" ON public.collab_cards
  FOR SELECT TO authenticated
  USING (public.is_collab_project_member(project_id));

DROP POLICY IF EXISTS "Source users insert collaboration cards" ON public.collab_cards;
-- 放行项目成员以本人 uid 写入自己的卡；拦截代他人写卡及非成员写卡。
CREATE POLICY "Source users insert collaboration cards" ON public.collab_cards
  FOR INSERT TO authenticated
  WITH CHECK (
    source_user_id = auth.uid()
    AND public.is_collab_project_member(project_id)
  );

DROP POLICY IF EXISTS "Source users update collaboration cards" ON public.collab_cards;
-- 放行来源用户更新自己的卡；拦截修改他人卡或转移卡归属。
CREATE POLICY "Source users update collaboration cards" ON public.collab_cards
  FOR UPDATE TO authenticated
  USING (
    source_user_id = auth.uid()
    AND public.is_collab_project_member(project_id)
  )
  WITH CHECK (
    source_user_id = auth.uid()
    AND public.is_collab_project_member(project_id)
  );

DROP POLICY IF EXISTS "Source users delete collaboration cards" ON public.collab_cards;
-- 放行来源用户删除自己的卡；拦截删除他人卡。
CREATE POLICY "Source users delete collaboration cards" ON public.collab_cards
  FOR DELETE TO authenticated
  USING (
    source_user_id = auth.uid()
    AND public.is_collab_project_member(project_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collab_cards TO authenticated;
