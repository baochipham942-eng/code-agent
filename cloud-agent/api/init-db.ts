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
  const initKey = req.headers['x-init-key'];
  const expectedKey = process.env.DB_INIT_KEY || process.env.AUTH_SECRET;

  if (!expectedKey) {
    return res.status(500).json({ error: 'DB_INIT_KEY or AUTH_SECRET not configured' });
  }

  if (initKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid init key' });
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
