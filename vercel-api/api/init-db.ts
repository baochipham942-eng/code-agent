// ============================================================================
// Initialize Database - 首次部署时初始化数据库 Schema
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { initializeSchema } from '../lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 验证初始化密钥（防止意外调用）
  // 重要：必须单独配置 DB_INIT_KEY，不要复用 AUTH_SECRET
  const initKey = req.headers['x-init-key'];
  const expectedKey = process.env.DB_INIT_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      error: 'DB_INIT_KEY not configured',
      hint: 'Set a separate DB_INIT_KEY environment variable for database initialization'
    });
  }

  if (!initKey || initKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing init key' });
  }

  try {
    const result = await initializeSchema();
    return res.status(200).json({
      success: true,
      message: 'Database schema initialized successfully',
      result,
    });
  } catch (error: any) {
    console.error('Database initialization error:', error);
    return res.status(500).json({
      error: 'Database initialization failed',
      message: error.message,
    });
  }
}
