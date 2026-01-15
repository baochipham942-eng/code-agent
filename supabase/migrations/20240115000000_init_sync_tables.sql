-- ============================================================================
-- Supabase Migration: Initialize sync tables for Code Agent
-- ============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- User Profiles Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  nickname TEXT,
  avatar_url TEXT,
  quick_login_token TEXT UNIQUE,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- ============================================================================
-- Devices Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  sync_cursor BIGINT DEFAULT 0,
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

-- Enable RLS
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own devices" ON public.devices
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own devices" ON public.devices
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- Sessions Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  model_provider TEXT,
  model_name TEXT,
  working_directory TEXT,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  source_device_id TEXT
);

-- Enable RLS
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own sessions" ON public.sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own sessions" ON public.sessions
  FOR ALL USING (auth.uid() = user_id);

-- Index for sync queries
CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
  ON public.sessions(user_id, updated_at);

-- ============================================================================
-- Messages Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.messages (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  is_deleted BOOLEAN DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  source_device_id TEXT
);

-- Enable RLS
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own messages" ON public.messages
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own messages" ON public.messages
  FOR ALL USING (auth.uid() = user_id);

-- Index for sync queries
CREATE INDEX IF NOT EXISTS idx_messages_user_updated
  ON public.messages(user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON public.messages(session_id);

-- ============================================================================
-- User Preferences Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  source_device_id TEXT,
  UNIQUE(user_id, key)
);

-- Enable RLS
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own preferences" ON public.user_preferences
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- Project Knowledge Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.project_knowledge (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_path TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  source TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  is_deleted BOOLEAN DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  source_device_id TEXT,
  UNIQUE(user_id, project_path, key)
);

-- Enable RLS
ALTER TABLE public.project_knowledge ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own knowledge" ON public.project_knowledge
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own knowledge" ON public.project_knowledge
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- Todos Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.todos (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES public.sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  active_form TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  source_device_id TEXT
);

-- Enable RLS
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own todos" ON public.todos
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own todos" ON public.todos
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- Invite Codes Table (Admin managed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  max_uses INTEGER DEFAULT 1,
  use_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (only allow read for validation)
ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can validate codes
CREATE POLICY "Anyone can read active invite codes" ON public.invite_codes
  FOR SELECT USING (is_active = true);

-- ============================================================================
-- Function: Increment invite code usage
-- ============================================================================
CREATE OR REPLACE FUNCTION public.increment_invite_code_usage(code_value TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE public.invite_codes
  SET use_count = use_count + 1
  WHERE code = code_value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Function: Auto-create profile on user signup
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for auto-creating profile
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- Insert a default invite code for testing (remove in production)
-- ============================================================================
INSERT INTO public.invite_codes (code, max_uses, is_active)
VALUES ('TESTCODE', 100, true)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- Vector Documents Table (for semantic search and memory)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.vector_documents (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1024),  -- DeepSeek default dimension, also supports 384/1536
  source TEXT NOT NULL,    -- 'file', 'conversation', 'knowledge'
  project_path TEXT,
  file_path TEXT,
  session_id TEXT REFERENCES public.sessions(id) ON DELETE SET NULL,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  source_device_id TEXT
);

-- Enable RLS
ALTER TABLE public.vector_documents ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own vectors" ON public.vector_documents
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own vectors" ON public.vector_documents
  FOR ALL USING (auth.uid() = user_id);

-- Index for sync queries
CREATE INDEX IF NOT EXISTS idx_vector_documents_user_updated
  ON public.vector_documents(user_id, updated_at);

-- Index for project-based queries
CREATE INDEX IF NOT EXISTS idx_vector_documents_project
  ON public.vector_documents(user_id, project_path);

-- HNSW index for fast vector similarity search
-- Using cosine distance for normalized embeddings
CREATE INDEX IF NOT EXISTS idx_vector_documents_embedding
  ON public.vector_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- Function: Vector similarity search
-- ============================================================================
CREATE OR REPLACE FUNCTION public.match_vectors(
  query_embedding vector(1024),
  match_user_id UUID,
  match_project_path TEXT DEFAULT NULL,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id TEXT,
  content TEXT,
  source TEXT,
  project_path TEXT,
  file_path TEXT,
  session_id TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    vd.id,
    vd.content,
    vd.source,
    vd.project_path,
    vd.file_path,
    vd.session_id,
    1 - (vd.embedding <=> query_embedding) AS similarity
  FROM public.vector_documents vd
  WHERE vd.user_id = match_user_id
    AND vd.is_deleted = FALSE
    AND (match_project_path IS NULL OR vd.project_path = match_project_path)
    AND 1 - (vd.embedding <=> query_embedding) > match_threshold
  ORDER BY vd.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
