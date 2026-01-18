-- ============================================================================
-- Cloud Tasks Migration - 云端任务执行系统数据库表
-- ============================================================================

-- 启用必要的扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 云端任务表
-- ============================================================================
CREATE TABLE IF NOT EXISTS cloud_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  project_id TEXT,

  -- 任务内容
  type TEXT NOT NULL CHECK (type IN ('researcher', 'analyzer', 'writer', 'reviewer', 'planner')),
  title TEXT NOT NULL,
  description TEXT,

  -- 加密的 prompt（敏感内容）
  encrypted_prompt JSONB, -- { iv, data, tag, algorithm }
  encryption_key_id TEXT, -- 用于标识使用哪个密钥

  -- 执行配置
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  location TEXT NOT NULL DEFAULT 'cloud' CHECK (location IN ('local', 'cloud', 'hybrid')),
  max_iterations INTEGER DEFAULT 20,
  timeout_ms INTEGER DEFAULT 120000,

  -- 状态
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  current_step TEXT,

  -- 结果（可能加密）
  encrypted_result JSONB, -- { iv, data, tag, algorithm }
  error TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 元数据
  metadata JSONB DEFAULT '{}'::jsonb
);

-- 索引
CREATE INDEX idx_cloud_tasks_user_id ON cloud_tasks(user_id);
CREATE INDEX idx_cloud_tasks_status ON cloud_tasks(status);
CREATE INDEX idx_cloud_tasks_type ON cloud_tasks(type);
CREATE INDEX idx_cloud_tasks_priority ON cloud_tasks(priority);
CREATE INDEX idx_cloud_tasks_created_at ON cloud_tasks(created_at DESC);
CREATE INDEX idx_cloud_tasks_session_id ON cloud_tasks(session_id) WHERE session_id IS NOT NULL;

-- ============================================================================
-- 任务进度日志表（用于实时更新）
-- ============================================================================
CREATE TABLE IF NOT EXISTS cloud_task_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,

  -- 日志内容
  log_type TEXT NOT NULL CHECK (log_type IN ('progress', 'tool_call', 'output', 'error', 'info')),
  message TEXT,
  progress INTEGER,
  current_step TEXT,

  -- 工具调用详情
  tool_name TEXT,
  tool_input JSONB,
  tool_output TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_cloud_task_logs_task_id ON cloud_task_logs(task_id);
CREATE INDEX idx_cloud_task_logs_created_at ON cloud_task_logs(created_at DESC);

-- ============================================================================
-- 用户加密密钥表（存储公钥信息，私钥在客户端）
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_encryption_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 密钥信息
  key_id TEXT NOT NULL, -- 客户端生成的密钥 ID
  public_key TEXT, -- 用于密钥交换的公钥（可选）
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',

  -- 状态
  is_active BOOLEAN DEFAULT true,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,

  UNIQUE(user_id, key_id)
);

-- 索引
CREATE INDEX idx_user_encryption_keys_user_id ON user_encryption_keys(user_id);

-- ============================================================================
-- 任务队列表（用于云端调度）
-- ============================================================================
CREATE TABLE IF NOT EXISTS cloud_task_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,

  -- 队列信息
  priority_score INTEGER NOT NULL DEFAULT 0, -- 综合优先级分数
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_at TIMESTAMPTZ,
  worker_id TEXT, -- 执行此任务的 worker 标识

  -- 重试信息
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  last_error TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(task_id)
);

-- 索引
CREATE INDEX idx_cloud_task_queue_priority ON cloud_task_queue(priority_score DESC, scheduled_at ASC)
  WHERE picked_at IS NULL;
CREATE INDEX idx_cloud_task_queue_worker ON cloud_task_queue(worker_id)
  WHERE worker_id IS NOT NULL;

-- ============================================================================
-- 云端执行统计表
-- ============================================================================
CREATE TABLE IF NOT EXISTS cloud_execution_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 统计周期
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('hourly', 'daily', 'weekly', 'monthly')),

  -- 统计数据
  total_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  failed_tasks INTEGER DEFAULT 0,
  cancelled_tasks INTEGER DEFAULT 0,

  -- 按类型统计
  stats_by_type JSONB DEFAULT '{}'::jsonb,
  -- 按位置统计
  stats_by_location JSONB DEFAULT '{}'::jsonb,

  -- 性能指标
  total_duration_ms BIGINT DEFAULT 0,
  avg_duration_ms INTEGER DEFAULT 0,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, period_start, period_type)
);

-- 索引
CREATE INDEX idx_cloud_execution_stats_user_period ON cloud_execution_stats(user_id, period_start DESC);

-- ============================================================================
-- RLS 策略
-- ============================================================================

-- 启用 RLS
ALTER TABLE cloud_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_task_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_task_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_execution_stats ENABLE ROW LEVEL SECURITY;

-- cloud_tasks 策略
CREATE POLICY "Users can view their own tasks"
  ON cloud_tasks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own tasks"
  ON cloud_tasks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tasks"
  ON cloud_tasks FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tasks"
  ON cloud_tasks FOR DELETE
  USING (auth.uid() = user_id);

-- cloud_task_logs 策略
CREATE POLICY "Users can view logs of their own tasks"
  ON cloud_task_logs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM cloud_tasks
    WHERE cloud_tasks.id = cloud_task_logs.task_id
    AND cloud_tasks.user_id = auth.uid()
  ));

CREATE POLICY "Service role can insert logs"
  ON cloud_task_logs FOR INSERT
  WITH CHECK (true); -- 由 Edge Function 使用 service role 插入

-- user_encryption_keys 策略
CREATE POLICY "Users can manage their own keys"
  ON user_encryption_keys FOR ALL
  USING (auth.uid() = user_id);

-- cloud_task_queue 策略
CREATE POLICY "Users can view their own queued tasks"
  ON cloud_task_queue FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM cloud_tasks
    WHERE cloud_tasks.id = cloud_task_queue.task_id
    AND cloud_tasks.user_id = auth.uid()
  ));

-- cloud_execution_stats 策略
CREATE POLICY "Users can view their own stats"
  ON cloud_execution_stats FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================================
-- 触发器函数：自动更新 updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION update_cloud_task_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cloud_tasks_updated_at
  BEFORE UPDATE ON cloud_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_cloud_task_updated_at();

-- ============================================================================
-- 触发器函数：任务完成时更新统计
-- ============================================================================
CREATE OR REPLACE FUNCTION update_task_stats_on_complete()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在状态变为 completed 或 failed 时触发
  IF NEW.status IN ('completed', 'failed') AND OLD.status NOT IN ('completed', 'failed') THEN
    -- 更新或创建每日统计
    INSERT INTO cloud_execution_stats (
      user_id,
      period_start,
      period_end,
      period_type,
      total_tasks,
      completed_tasks,
      failed_tasks,
      total_duration_ms
    )
    VALUES (
      NEW.user_id,
      date_trunc('day', NOW()),
      date_trunc('day', NOW()) + INTERVAL '1 day',
      'daily',
      1,
      CASE WHEN NEW.status = 'completed' THEN 1 ELSE 0 END,
      CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      COALESCE(EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at)) * 1000, 0)::BIGINT
    )
    ON CONFLICT (user_id, period_start, period_type)
    DO UPDATE SET
      total_tasks = cloud_execution_stats.total_tasks + 1,
      completed_tasks = cloud_execution_stats.completed_tasks +
        CASE WHEN NEW.status = 'completed' THEN 1 ELSE 0 END,
      failed_tasks = cloud_execution_stats.failed_tasks +
        CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      total_duration_ms = cloud_execution_stats.total_duration_ms +
        COALESCE(EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at)) * 1000, 0)::BIGINT,
      avg_duration_ms = (
        cloud_execution_stats.total_duration_ms +
        COALESCE(EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at)) * 1000, 0)::BIGINT
      ) / (cloud_execution_stats.total_tasks + 1);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_task_stats
  AFTER UPDATE ON cloud_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_task_stats_on_complete();

-- ============================================================================
-- 函数：获取下一个待执行的任务
-- ============================================================================
CREATE OR REPLACE FUNCTION get_next_cloud_task(p_worker_id TEXT)
RETURNS TABLE (
  task_id UUID,
  user_id UUID,
  type TEXT,
  encrypted_prompt JSONB,
  encryption_key_id TEXT,
  max_iterations INTEGER,
  timeout_ms INTEGER,
  metadata JSONB
) AS $$
DECLARE
  v_queue_id UUID;
  v_task_id UUID;
BEGIN
  -- 选择并锁定下一个任务
  SELECT q.id, q.task_id INTO v_queue_id, v_task_id
  FROM cloud_task_queue q
  JOIN cloud_tasks t ON t.id = q.task_id
  WHERE q.picked_at IS NULL
    AND t.status = 'queued'
    AND q.retry_count < q.max_retries
  ORDER BY q.priority_score DESC, q.scheduled_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_queue_id IS NULL THEN
    RETURN;
  END IF;

  -- 标记为已选取
  UPDATE cloud_task_queue
  SET picked_at = NOW(), worker_id = p_worker_id
  WHERE id = v_queue_id;

  -- 更新任务状态
  UPDATE cloud_tasks
  SET status = 'running', started_at = COALESCE(started_at, NOW())
  WHERE id = v_task_id;

  -- 返回任务详情
  RETURN QUERY
  SELECT
    t.id,
    t.user_id,
    t.type,
    t.encrypted_prompt,
    t.encryption_key_id,
    t.max_iterations,
    t.timeout_ms,
    t.metadata
  FROM cloud_tasks t
  WHERE t.id = v_task_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 函数：将任务加入队列
-- ============================================================================
CREATE OR REPLACE FUNCTION enqueue_cloud_task(p_task_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_priority TEXT;
  v_priority_score INTEGER;
BEGIN
  -- 获取任务优先级
  SELECT priority INTO v_priority
  FROM cloud_tasks
  WHERE id = p_task_id;

  IF v_priority IS NULL THEN
    RETURN FALSE;
  END IF;

  -- 计算优先级分数
  v_priority_score := CASE v_priority
    WHEN 'urgent' THEN 1000
    WHEN 'high' THEN 100
    WHEN 'normal' THEN 10
    WHEN 'low' THEN 1
    ELSE 10
  END;

  -- 插入队列
  INSERT INTO cloud_task_queue (task_id, priority_score)
  VALUES (p_task_id, v_priority_score)
  ON CONFLICT (task_id) DO UPDATE
  SET priority_score = v_priority_score, scheduled_at = NOW();

  -- 更新任务状态
  UPDATE cloud_tasks
  SET status = 'queued'
  WHERE id = p_task_id AND status = 'pending';

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
