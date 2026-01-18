// ============================================================================
// User API Keys Management
// GET  /api/user-keys              - 获取 Key 配置状态
// POST /api/user-keys              - 保存 API Key
// DELETE /api/user-keys?type=xxx   - 删除 API Key
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../lib/auth.js';
import {
  getUserKeyStatus,
  saveUserApiKey,
  deleteUserApiKey,
  type ApiKeyType,
} from '../lib/apiKeys.js';

const VALID_KEY_TYPES: ApiKeyType[] = ['deepseek', 'openai', 'anthropic', 'perplexity'];

function isValidKeyType(type: string): type is ApiKeyType {
  return VALID_KEY_TYPES.includes(type as ApiKeyType);
}

// 获取 Key 配置状态
async function handleGetStatus(req: VercelRequest, res: VercelResponse) {
  const auth = await authenticateRequest(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const status = await getUserKeyStatus(auth.userId);
    return res.status(200).json({ success: true, ...status });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ success: false, error: err.message });
  }
}

// 保存 API Key
async function handleSaveKey(req: VercelRequest, res: VercelResponse) {
  const auth = await authenticateRequest(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, apiKey } = req.body as { type: string; apiKey: string };

  if (!type || !isValidKeyType(type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid key type. Must be one of: ${VALID_KEY_TYPES.join(', ')}`,
    });
  }

  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid API key' });
  }

  try {
    await saveUserApiKey(auth.userId, type, apiKey);
    return res.status(200).json({ success: true, message: `${type} API key saved` });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ success: false, error: err.message });
  }
}

// 删除 API Key
async function handleDeleteKey(req: VercelRequest, res: VercelResponse) {
  const auth = await authenticateRequest(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const type = req.query.type as string;

  if (!type || !isValidKeyType(type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid key type. Must be one of: ${VALID_KEY_TYPES.join(', ')}`,
    });
  }

  try {
    await deleteUserApiKey(auth.userId, type);
    return res.status(200).json({ success: true, message: `${type} API key deleted` });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ success: false, error: err.message });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  switch (req.method) {
    case 'GET':
      return handleGetStatus(req, res);
    case 'POST':
      return handleSaveKey(req, res);
    case 'DELETE':
      return handleDeleteKey(req, res);
    default:
      return res.status(405).json({ error: 'Method not allowed' });
  }
}
