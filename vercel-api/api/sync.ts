// ============================================================================
// Sync API - 统一同步接口
// POST /api/sync?action=push   - 推送数据到云端
// GET  /api/sync?action=pull   - 从云端拉取数据
// GET  /api/sync?action=stats  - 获取同步统计
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../lib/auth.js';
import { setCorsHeaders, handleOptions, applyRateLimit, handleError } from '../lib/middleware.js';
import { RATE_LIMITS } from '../lib/rateLimit.js';
import {
  syncSessions,
  syncMessages,
  pullUserData,
  getUserStats,
  type SyncSessionRequest,
  type SyncMessageRequest,
} from '../lib/sync.js';

// 推送数据
async function handlePush(req: VercelRequest, res: VercelResponse, userId: string) {
  const body = req.body as {
    sessions?: SyncSessionRequest[];
    messages?: SyncMessageRequest[];
  };

  const results = {
    sessions: { synced: 0, errors: [] as string[] },
    messages: { synced: 0, errors: [] as string[] },
  };

  if (body.sessions?.length) {
    results.sessions = await syncSessions(userId, body.sessions);
  }
  if (body.messages?.length) {
    results.messages = await syncMessages(userId, body.messages);
  }

  return res.status(200).json({ success: true, results, serverTime: new Date().toISOString() });
}

// 拉取数据
async function handlePull(req: VercelRequest, res: VercelResponse, userId: string) {
  const since = req.query.since as string | undefined;
  const data = await pullUserData(userId, since);
  return res.status(200).json({ success: true, data });
}

// 获取统计
async function handleStats(req: VercelRequest, res: VercelResponse, userId: string) {
  const stats = await getUserStats(userId);
  return res.status(200).json({ success: true, stats });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS - 限制允许的来源
  setCorsHeaders(req, res);
  if (handleOptions(req, res)) return;

  // 验证用户
  const payload = await authenticateRequest(req.headers.authorization);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limiting
  if (applyRateLimit(req, res, payload.userId, RATE_LIMITS.sync)) return;

  const action = req.query.action as string;

  try {
    switch (action) {
      case 'push':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return handlePush(req, res, payload.userId);
      case 'pull':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return handlePull(req, res, payload.userId);
      case 'stats':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return handleStats(req, res, payload.userId);
      default:
        return res.status(400).json({ error: 'Invalid action. Use: push, pull, stats' });
    }
  } catch (err) {
    handleError(res, err, 'Sync operation failed');
  }
}
