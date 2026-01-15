// ============================================================================
// Database Connection - Neon PostgreSQL
// ============================================================================

import { neon, neonConfig } from '@neondatabase/serverless';

// 启用 fetch 连接模式（Vercel Edge 兼容）
neonConfig.fetchConnectionCache = true;

let sqlClient: ReturnType<typeof neon> | null = null;

export function getDb() {
  if (!sqlClient) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    sqlClient = neon(databaseUrl);
  }
  return sqlClient;
}

// 类型定义
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  provider: string;
  provider_id: string;
  created_at: Date;
  last_login_at: Date | null;
}

export interface Session {
  id: string;
  user_id: string;
  title: string;
  generation: number;
  workspace_path: string | null;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: Record<string, unknown>[] | null;
  created_at: Date;
}

export interface Release {
  id: number;
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  download_url: string;
  release_notes: string | null;
  file_size: number | null;
  is_latest: boolean;
  published_at: Date;
}

// 初始化数据库 Schema（首次部署时运行）
export async function initializeSchema() {
  const sql = getDb();

  await sql`
    CREATE SCHEMA IF NOT EXISTS code_agent;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS code_agent.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      avatar_url TEXT,
      provider VARCHAR(50) NOT NULL,
      provider_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login_at TIMESTAMP,
      UNIQUE(provider, provider_id)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS code_agent.sessions (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES code_agent.users(id) ON DELETE CASCADE,
      title VARCHAR(500),
      generation INTEGER DEFAULT 1,
      workspace_path TEXT,
      config JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS code_agent.messages (
      id UUID PRIMARY KEY,
      session_id UUID REFERENCES code_agent.sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT,
      tool_calls JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS code_agent.releases (
      id SERIAL PRIMARY KEY,
      version VARCHAR(20) NOT NULL,
      platform VARCHAR(20) NOT NULL,
      download_url TEXT NOT NULL,
      release_notes TEXT,
      file_size BIGINT,
      is_latest BOOLEAN DEFAULT FALSE,
      published_at TIMESTAMP DEFAULT NOW()
    );
  `;

  // 创建索引
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON code_agent.sessions(user_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_session ON code_agent.messages(session_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_created ON code_agent.messages(session_id, created_at);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_releases_latest ON code_agent.releases(platform, is_latest);`;

  return { success: true };
}
