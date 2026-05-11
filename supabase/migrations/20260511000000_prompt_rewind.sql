-- Prompt rewind: preserve hidden attempts while keeping active transcript clean.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS hidden_by_rewind_id TEXT,
  ADD COLUMN IF NOT EXISTS hidden_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_messages_user_visibility_updated
  ON public.messages(user_id, visibility, updated_at);

CREATE TABLE IF NOT EXISTS public.session_rewinds (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  anchor_message_id TEXT NOT NULL,
  anchor_prompt TEXT NOT NULL,
  anchor_timestamp BIGINT NOT NULL,
  checkpoint_message_id TEXT,
  hidden_message_count INTEGER NOT NULL DEFAULT 0,
  hidden_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_restored INTEGER NOT NULL DEFAULT 0,
  files_deleted INTEGER NOT NULL DEFAULT 0,
  errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  source_device_id TEXT
);

ALTER TABLE public.session_rewinds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own session rewinds" ON public.session_rewinds
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own session rewinds" ON public.session_rewinds
  FOR ALL USING (auth.uid() = user_id);
