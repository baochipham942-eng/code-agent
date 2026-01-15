// ============================================================================
// Task Execution Endpoint - 执行云端任务
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { executeBrowserTask } from '../lib/browser';
import { executeComputeTask } from '../lib/compute';
import { executeSkillTask } from '../lib/skills';

interface CloudTaskRequest {
  id: string;
  type: 'browser' | 'compute' | 'skill';
  payload: {
    action?: string;
    url?: string;
    script?: string;
    skillName?: string;
    params?: Record<string, unknown>;
  };
  timeout?: number;
}

interface CloudTaskResponse {
  id: string;
  status: 'success' | 'error' | 'timeout';
  result?: unknown;
  error?: string;
  duration?: number;
  screenshots?: string[];
}

// 验证 API Key
function validateApiKey(req: VercelRequest): boolean {
  const cloudApiKey = process.env.CLOUD_API_KEY;
  if (!cloudApiKey) {
    // 如果没有配置 API Key，允许所有请求（开发模式）
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  return token === cloudApiKey;
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

  // 验证 API Key
  if (!validateApiKey(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const request = req.body as CloudTaskRequest;

  if (!request.id || !request.type) {
    return res.status(400).json({
      id: request?.id || 'unknown',
      status: 'error',
      error: 'Missing required fields: id, type',
    });
  }

  let response: CloudTaskResponse;

  try {
    switch (request.type) {
      case 'browser':
        response = await executeBrowserTask(request);
        break;

      case 'compute':
        response = await executeComputeTask(request);
        break;

      case 'skill':
        response = await executeSkillTask(request);
        break;

      default:
        response = {
          id: request.id,
          status: 'error',
          error: `Unknown task type: ${request.type}`,
        };
    }
  } catch (error: any) {
    console.error('Task execution error:', error);
    response = {
      id: request.id,
      status: 'error',
      error: error.message || 'Unknown error occurred',
    };
  }

  response.duration = Date.now() - startTime;

  return res.status(response.status === 'error' ? 500 : 200).json(response);
}
