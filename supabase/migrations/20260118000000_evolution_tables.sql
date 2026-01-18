-- ============================================================================
-- Evolution Tables Migration
-- Creates tables for Gen8 self-evolution persistence
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Strategies Table
-- Stores user-created work strategies
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_strategies (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    steps TEXT[] NOT NULL DEFAULT '{}',
    success_rate REAL NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used BIGINT NOT NULL DEFAULT 0,
    tags TEXT[] NOT NULL DEFAULT '{}',
    project_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_evolution_strategies_user_id
ON evolution_strategies(user_id);

-- Index for tag-based queries
CREATE INDEX IF NOT EXISTS idx_evolution_strategies_tags
ON evolution_strategies USING GIN(tags);

-- Enable RLS
ALTER TABLE evolution_strategies ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own strategies"
ON evolution_strategies FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own strategies"
ON evolution_strategies FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own strategies"
ON evolution_strategies FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own strategies"
ON evolution_strategies FOR DELETE
USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Patterns Table
-- Stores learned patterns (success, failure, optimization, anti-pattern)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_patterns (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('success', 'failure', 'optimization', 'anti_pattern')),
    context TEXT NOT NULL,
    pattern TEXT NOT NULL,
    solution TEXT,
    confidence REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
    occurrences INTEGER NOT NULL DEFAULT 1,
    last_seen BIGINT NOT NULL DEFAULT 0,
    tags TEXT[] NOT NULL DEFAULT '{}',
    project_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_user_id
ON evolution_patterns(user_id);

-- Index for type-based queries
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_type
ON evolution_patterns(type);

-- Index for tag-based queries
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_tags
ON evolution_patterns USING GIN(tags);

-- Index for high-confidence pattern queries
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_confidence
ON evolution_patterns(confidence DESC);

-- Enable RLS
ALTER TABLE evolution_patterns ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own patterns"
ON evolution_patterns FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own patterns"
ON evolution_patterns FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own patterns"
ON evolution_patterns FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own patterns"
ON evolution_patterns FOR DELETE
USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Strategy Feedback Table
-- Stores feedback history for strategies
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_strategy_feedback (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    strategy_id TEXT NOT NULL REFERENCES evolution_strategies(id) ON DELETE CASCADE,
    success BOOLEAN NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for strategy queries
CREATE INDEX IF NOT EXISTS idx_evolution_feedback_strategy_id
ON evolution_strategy_feedback(strategy_id);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_evolution_feedback_user_id
ON evolution_strategy_feedback(user_id);

-- Enable RLS
ALTER TABLE evolution_strategy_feedback ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own feedback"
ON evolution_strategy_feedback FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own feedback"
ON evolution_strategy_feedback FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Add tables to sync scope
-- ----------------------------------------------------------------------------
-- These tables will be included in the cloud sync mechanism

-- Comment for documentation
COMMENT ON TABLE evolution_strategies IS 'Gen8 self-evolution: User work strategies';
COMMENT ON TABLE evolution_patterns IS 'Gen8 self-evolution: Learned patterns from experience';
COMMENT ON TABLE evolution_strategy_feedback IS 'Gen8 self-evolution: Strategy feedback history';
