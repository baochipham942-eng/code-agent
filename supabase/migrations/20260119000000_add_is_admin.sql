-- ============================================================================
-- Migration: Add is_admin field to profiles table
-- ============================================================================

-- Add is_admin column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- Create index for admin queries
CREATE INDEX IF NOT EXISTS idx_profiles_is_admin
  ON public.profiles(is_admin)
  WHERE is_admin = TRUE;

-- Comment on column
COMMENT ON COLUMN public.profiles.is_admin IS 'Admin users can use cloud API keys for model requests';
