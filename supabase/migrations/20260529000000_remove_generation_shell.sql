-- Remove deprecated runtime generation shell from cloud sessions.
-- Historical migrations/docs may still mention the old phase model, but the
-- current sync contract no longer carries a session-level generation id.

ALTER TABLE public.sessions
  DROP COLUMN IF EXISTS generation_id;
