// ============================================================================
// cloud_api - 通用 API 调用工具
// POST /api/tools/cloud-api
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  maxDuration: 30,
};

interface ApiRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

interface ApiResult {
  statusCode: number;
  data?: unknown;
  headers: Record<string, string>;
  responseTime: number;
}

/**
 * 检查是否为允许的 URL
 */
function isAllowedUrl(hostname: string): boolean {
  // 阻止的主机
  const blockedHosts = [
    '169.254.169.254',
    'metadata.google.internal',
    '100.100.100.200',
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.',
    '172.16.',
    '172.17.',
    '172.18.',
    '172.19.',
    '172.20.',
    '172.21.',
    '172.22.',
    '172.23.',
    '172.24.',
    '172.25.',
    '172.26.',
    '172.27.',
    '172.28.',
    '172.29.',
    '172.30.',
    '172.31.',
    '192.168.',
  ];

  const lowerHostname = hostname.toLowerCase();

  for (const blocked of blockedHosts) {
    if (lowerHostname === blocked || lowerHostname.startsWith(blocked)) {
      return false;
    }
  }

  return true;
}

/**
 * 提取响应头
 */
function extractHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    // 只保留安全的响应头
    const safeHeaders = [
      'content-type',
      'content-length',
      'date',
      'etag',
      'last-modified',
      'cache-control',
      'x-request-id',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
    ];
    if (safeHeaders.includes(key.toLowerCase())) {
      result[key] = value;
    }
  });
  return result;
}

async function handleApiCall(req: VercelRequest, res: VercelResponse) {
  const body = req.body as ApiRequest;
  const { url, method, headers = {}, body: requestBody, timeout = 30000 } = body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  if (!method) {
    return res.status(400).json({ success: false, error: 'Method is required' });
  }

  // URL 验证
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format' });
  }

  // 协议检查
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ success: false, error: 'Only HTTP(S) URLs are allowed' });
  }

  // 安全检查
  if (!isAllowedUrl(parsedUrl.hostname)) {
    return res.status(403).json({ success: false, error: 'Access to this URL is not allowed' });
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // 构建请求头
    const requestHeaders: Record<string, string> = {
      'User-Agent': 'CodeAgent/1.0',
      ...headers,
    };

    // 如果有请求体且没有 Content-Type，默认设置为 JSON
    if (requestBody && !requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
      signal: controller.signal,
      redirect: 'follow',
    };

    // 添加请求体
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = typeof requestBody === 'string'
        ? requestBody
        : JSON.stringify(requestBody);
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    const responseTime = Date.now() - startTime;
    const contentType = response.headers.get('content-type') || '';

    // 解析响应
    let data: unknown;
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        data = await response.text();
      }
    } else {
      const text = await response.text();
      // 限制文本长度
      data = text.slice(0, 50000);
    }

    const result: ApiResult = {
      statusCode: response.status,
      data,
      headers: extractHeaders(response.headers),
      responseTime,
    };

    return res.status(200).json({
      success: response.ok,
      ...result,
      duration: Date.now() - startTime,
    });
  } catch (error: unknown) {
    const err = error as Error & { name?: string };
    if (err.name === 'AbortError') {
      return res.status(408).json({
        success: false,
        error: 'Request timeout',
        duration: Date.now() - startTime,
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'API call failed',
      duration: Date.now() - startTime,
    });
  }
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

  return handleApiCall(req, res);
}
