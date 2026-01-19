// ============================================================================
// Model Proxy - 模型 API 代理服务
// POST /api/model-proxy
// 为客户端提供模型 API 代理，服务端注入 API Key
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('ModelProxy');

export const config = {
  maxDuration: 60, // 模型请求可能较慢
};

// 支持的 provider 和对应的 API 配置
const PROVIDERS: Record<string, { baseUrl: string; envKey: string; authHeader: string }> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    authHeader: 'Authorization',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    authHeader: 'Authorization',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    authHeader: 'x-api-key',
  },
};

interface ProxyRequest {
  provider: string;
  endpoint: string; // e.g., '/chat/completions'
  body: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { provider, endpoint, body } = req.body as ProxyRequest;

  if (!provider || !endpoint || !body) {
    return res.status(400).json({
      error: 'Missing required fields: provider, endpoint, body',
    });
  }

  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) {
    return res.status(400).json({
      error: `Unsupported provider: ${provider}. Supported: ${Object.keys(PROVIDERS).join(', ')}`,
    });
  }

  // 从环境变量获取 API Key
  const apiKey = process.env[providerConfig.envKey];
  if (!apiKey) {
    logger.error('Missing API key for provider', undefined, { provider });
    return res.status(500).json({
      error: `API key not configured for provider: ${provider}`,
    });
  }

  const url = `${providerConfig.baseUrl}${endpoint}`;

  try {
    // 构建请求头
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // 根据 provider 设置认证头
    if (providerConfig.authHeader === 'Authorization') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers[providerConfig.authHeader] = apiKey;
    }

    // OpenRouter 额外头
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://code-agent.app';
      headers['X-Title'] = 'Code Agent';
    }

    // Anthropic 额外头
    if (provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
    }

    logger.info('Proxying request', { provider, endpoint });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const contentType = response.headers.get('content-type') || '';

    // 解析响应
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    // 返回响应
    return res.status(response.status).json(data);
  } catch (error: unknown) {
    const err = error as Error;
    logger.error('Proxy request failed', err);
    return res.status(500).json({
      error: err.message || 'Proxy request failed',
    });
  }
}
