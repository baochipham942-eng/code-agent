// ============================================================================
// Sync Pull - 从云端拉取数据到客户端
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth';
import { pullUserData } from '../../lib/sync';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 验证用户
  const payload = await authenticateRequest(req.headers.authorization);

  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 从查询参数获取增量同步时间
  const since = req.query.since as string | undefined;

  try {
    const data = await pullUserData(payload.userId, since);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('Pull error:', error);
    return res.status(500).json({
      error: 'Failed to pull data',
      message: error.message,
    });
  }
}
