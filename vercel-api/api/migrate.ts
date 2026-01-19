// ============================================================================
// Database Migration - 增量迁移
// POST /api/migrate
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, ADMIN_EMAILS } from '../lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 验证密钥
  const initKey = req.headers['x-init-key'];
  const expectedKey = process.env.DB_INIT_KEY;

  if (!expectedKey) {
    return res.status(500).json({ error: 'DB_INIT_KEY not configured' });
  }

  if (!initKey || initKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing init key' });
  }

  const sql = getDb();
  const results: string[] = [];

  try {
    // 1. 添加 role 字段到 users 表（如果不存在）
    try {
      await sql`
        ALTER TABLE code_agent.users
        ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'
      `;
      results.push('Added role column to users table');
    } catch (e) {
      results.push(`role column: ${(e as Error).message}`);
    }

    // 2. 创建 user_api_keys 表（如果不存在）
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS code_agent.user_api_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES code_agent.users(id) ON DELETE CASCADE UNIQUE,
          deepseek_api_key TEXT,
          openai_api_key TEXT,
          anthropic_api_key TEXT,
          perplexity_api_key TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;
      results.push('Created user_api_keys table');
    } catch (e) {
      results.push(`user_api_keys table: ${(e as Error).message}`);
    }

    // 3. 将管理员邮箱对应的用户设为 admin
    for (const email of ADMIN_EMAILS) {
      try {
        const updated = await sql`
          UPDATE code_agent.users
          SET role = 'admin'
          WHERE email = ${email}
          RETURNING id, email
        `;
        if ((updated as any[]).length > 0) {
          results.push(`Set ${email} as admin`);
        }
      } catch (e) {
        results.push(`Admin ${email}: ${(e as Error).message}`);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Migration completed',
      results,
    });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({
      success: false,
      error: err.message,
      results,
    });
  }
}
