// ============================================================================
// Logout - 登出（客户端需清除本地 Token）
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // JWT 是无状态的，服务端不需要做任何事情
  // 客户端负责清除本地存储的 Token
  // 如果需要吊销 Token，可以实现 Token 黑名单（暂不实现）

  return res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
}
