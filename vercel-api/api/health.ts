// ============================================================================
// Health Check Endpoint - 用于 warmup 和状态检查
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

const startTime = Date.now();

export default function handler(req: VercelRequest, res: VercelResponse) {
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

  return res.status(200).json({
    status: 'ok',
    version: '0.1.0',
    uptime: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
}
