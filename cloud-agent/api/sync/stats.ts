// ============================================================================
// Sync Stats - 获取用户同步统计信息
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth';
import { getUserStats } from '../../lib/sync';

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

  try {
    const stats = await getUserStats(payload.userId);

    return res.status(200).json({
      success: true,
      stats,
    });
  } catch (error: any) {
    console.error('Stats error:', error);
    return res.status(500).json({
      error: 'Failed to get stats',
      message: error.message,
    });
  }
}
