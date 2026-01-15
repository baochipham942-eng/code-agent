// ============================================================================
// Get Current User - 获取当前登录用户信息
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest, getUserById } from '../../lib/auth';

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

  // 验证 Token
  const payload = await authenticateRequest(req.headers.authorization);

  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 获取用户完整信息
  const user = await getUserById(payload.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.status(200).json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    provider: user.provider,
    createdAt: user.created_at,
  });
}
