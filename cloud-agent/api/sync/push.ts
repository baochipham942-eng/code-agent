// ============================================================================
// Sync Push - 客户端推送数据到云端
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth';
import {
  syncSessions,
  syncMessages,
  type SyncSessionRequest,
  type SyncMessageRequest,
} from '../../lib/sync';

interface PushRequest {
  sessions?: SyncSessionRequest[];
  messages?: SyncMessageRequest[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // 验证用户
  const payload = await authenticateRequest(req.headers.authorization);

  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body as PushRequest;

  const results = {
    sessions: { synced: 0, errors: [] as string[] },
    messages: { synced: 0, errors: [] as string[] },
  };

  // 同步 Sessions
  if (body.sessions && body.sessions.length > 0) {
    results.sessions = await syncSessions(payload.userId, body.sessions);
  }

  // 同步 Messages
  if (body.messages && body.messages.length > 0) {
    results.messages = await syncMessages(payload.userId, body.messages);
  }

  return res.status(200).json({
    success: true,
    results,
    serverTime: new Date().toISOString(),
  });
}
