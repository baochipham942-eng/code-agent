-- 20260517 was edited in place, which does not reach databases that already ran it.
-- Add a new idempotent migration so existing deployments receive the new artifact_kind.
DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.control_plane_audit_events') IS NOT NULL THEN
    FOR c IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'public'
        AND rel.relname = 'control_plane_audit_events'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%artifact_kind%'
    LOOP
      EXECUTE format('ALTER TABLE public.control_plane_audit_events DROP CONSTRAINT %I', c.conname);
    END LOOP;

    ALTER TABLE public.control_plane_audit_events
      ADD CONSTRAINT control_plane_audit_events_artifact_kind_check
      CHECK (
        artifact_kind IN (
          'cloud_config',
          'capability_registry',
          'agent_engine_model_catalog',
          'prompt_registry',
          'update_manifest'
        )
      );
  END IF;
END $$;
