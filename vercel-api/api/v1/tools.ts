// ============================================================================
// Cloud Tools - 合并的云端工具 API
// POST /api/v1/tools?action=api|memory-store|memory-search|scrape|search
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth.js';
import { getApiKey } from '../../lib/apiKeys.js';

export const config = {
  maxDuration: 30,
};

// ============================================================================
// 通用工具函数
// ============================================================================

function isBlockedHost(hostname: string): boolean {
  const blockedHosts = [
    '169.254.169.254', 'metadata.google.internal', '100.100.100.200',
    'localhost', '127.0.0.1', '0.0.0.0',
  ];
  const lowerHostname = hostname.toLowerCase();
  for (const blocked of blockedHosts) {
    if (lowerHostname === blocked || lowerHostname.startsWith(blocked) ||
        lowerHostname.startsWith('10.') || lowerHostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(lowerHostname)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// API 调用工具
// ============================================================================

async function handleApiCall(req: VercelRequest, res: VercelResponse) {
  const { url, method, headers = {}, body: requestBody, timeout = 30000 } = req.body;

  if (!url || !method) {
    return res.status(400).json({ success: false, error: 'URL and method are required' });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || isBlockedHost(parsedUrl.hostname)) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const requestHeaders: Record<string, string> = { 'User-Agent': 'CodeAgent/1.0', ...headers };
    if (requestBody && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      signal: controller.signal,
      body: requestBody && ['POST', 'PUT', 'PATCH'].includes(method)
        ? (typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody))
        : undefined,
    });
    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      try { data = await response.json(); } catch { data = await response.text(); }
    } else {
      data = (await response.text()).slice(0, 50000);
    }

    return res.status(200).json({
      success: response.ok,
      statusCode: response.status,
      data,
      duration: Date.now() - startTime,
    });
  } catch (error: any) {
    return res.status(error.name === 'AbortError' ? 408 : 500).json({
      success: false,
      error: error.name === 'AbortError' ? 'Request timeout' : error.message,
      duration: Date.now() - startTime,
    });
  }
}

// ============================================================================
// 网页抓取工具
// ============================================================================

function parseHtml(html: string) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, content };
}

async function handleScrape(req: VercelRequest, res: VercelResponse) {
  const { url, timeout = 30000 } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || isBlockedHost(parsedUrl.hostname)) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const html = await response.text();
    const parsed = parseHtml(html);

    return res.status(200).json({
      success: true,
      data: {
        url,
        title: parsed.title,
        content: parsed.content.slice(0, 10000),
        statusCode: response.status,
      },
      duration: Date.now() - startTime,
    });
  } catch (error: any) {
    return res.status(error.name === 'AbortError' ? 408 : 500).json({
      success: false,
      error: error.name === 'AbortError' ? 'Request timeout' : error.message,
      duration: Date.now() - startTime,
    });
  }
}

// ============================================================================
// 搜索工具
// ============================================================================

async function handleSearch(req: VercelRequest, res: VercelResponse) {
  const { query, maxResults = 10 } = req.body;

  if (!query) {
    return res.status(400).json({ success: false, error: 'Query is required' });
  }

  const startTime = Date.now();
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;

  // 尝试获取用户的 Perplexity Key
  let perplexityKey: string | null = null;
  try {
    const authHeader = req.headers.authorization as string | undefined;
    if (authHeader) {
      const authPayload = await authenticateRequest(authHeader);
      if (authPayload) {
        const keyResult = await getApiKey(authPayload.userId, 'perplexity');
        if (keyResult) perplexityKey = keyResult.key;
      }
    }
  } catch {}

  try {
    if (perplexityKey) {
      // Perplexity API
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${perplexityKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{ role: 'user', content: query }],
          max_tokens: 1024,
          return_citations: true,
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        return res.status(200).json({
          success: true,
          query,
          answer: data.choices?.[0]?.message?.content,
          citations: data.citations || [],
          source: 'perplexity',
          duration: Date.now() - startTime,
        });
      }
    }

    // Brave Search 备用
    if (braveApiKey) {
      const params = new URLSearchParams({ q: query, count: String(Math.min(maxResults, 20)) });
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { 'X-Subscription-Token': braveApiKey },
      });

      if (response.ok) {
        const data = await response.json() as any;
        const results = (data.web?.results || []).slice(0, maxResults).map((r: any) => ({
          title: r.title,
          url: r.url,
          snippet: r.description || '',
        }));
        return res.status(200).json({
          success: true,
          query,
          results,
          source: 'brave',
          duration: Date.now() - startTime,
        });
      }
    }

    return res.status(503).json({
      success: false,
      error: 'No search API available',
      duration: Date.now() - startTime,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: Date.now() - startTime,
    });
  }
}

// ============================================================================
// 主处理函数
// ============================================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action as string;

  switch (action) {
    case 'api':
      return handleApiCall(req, res);
    case 'scrape':
      return handleScrape(req, res);
    case 'search':
      return handleSearch(req, res);
    default:
      return res.status(400).json({
        error: 'Invalid action. Use: api, scrape, search',
        examples: {
          api: 'POST /api/v1/tools?action=api',
          scrape: 'POST /api/v1/tools?action=scrape',
          search: 'POST /api/v1/tools?action=search',
        },
      });
  }
}
