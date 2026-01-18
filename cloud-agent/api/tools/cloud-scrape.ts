// ============================================================================
// cloud_scrape - 网页抓取工具
// POST /api/tools/cloud-scrape
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  maxDuration: 30,
};

interface ScrapeRequest {
  url: string;
  selector?: string;
  extractJsonLd?: boolean;
  timeout?: number;
}

interface ScrapeResult {
  url: string;
  title?: string;
  content: string;
  html?: string;
  extractedData?: Record<string, string>;
  jsonLd?: unknown[];
  metadata: {
    statusCode: number;
    contentType: string;
    responseTime: number;
  };
}

/**
 * 简单的 HTML 解析器（不依赖 cheerio）
 */
function parseHtml(html: string) {
  // 提取标题
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  // 移除 script 和 style
  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // 提取 JSON-LD
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const jsonLd: unknown[] = [];
  for (const match of jsonLdMatches) {
    try {
      jsonLd.push(JSON.parse(match[1]));
    } catch {
      // 忽略解析错误
    }
  }

  // 移除所有 HTML 标签
  content = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, content, jsonLd };
}

/**
 * 简单的 CSS 选择器匹配
 * 支持: tag, .class, #id, tag.class
 */
function querySelector(html: string, selector: string): string[] {
  const results: string[] = [];

  // 简单的选择器解析
  let tagName = '';
  let className = '';
  let idName = '';

  if (selector.startsWith('#')) {
    idName = selector.slice(1);
  } else if (selector.startsWith('.')) {
    className = selector.slice(1);
  } else if (selector.includes('.')) {
    const parts = selector.split('.');
    tagName = parts[0];
    className = parts[1];
  } else {
    tagName = selector;
  }

  // 构建正则表达式
  let pattern: RegExp;

  if (idName) {
    pattern = new RegExp(`<[^>]+id=["']${idName}["'][^>]*>([\\s\\S]*?)<`, 'gi');
  } else if (tagName && className) {
    pattern = new RegExp(`<${tagName}[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  } else if (className) {
    pattern = new RegExp(`<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<`, 'gi');
  } else if (tagName) {
    pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  } else {
    return results;
  }

  let match;
  while ((match = pattern.exec(html)) !== null) {
    // 清理内容
    const content = match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (content) {
      results.push(content);
    }
  }

  return results;
}

/**
 * 检查是否为高风险 URL
 */
function isBlockedUrl(hostname: string): boolean {
  const blockedHosts = [
    '169.254.169.254',
    'metadata.google.internal',
    '100.100.100.200',
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
  ];
  return blockedHosts.includes(hostname.toLowerCase());
}

async function handleScrape(req: VercelRequest, res: VercelResponse) {
  const body = req.body as ScrapeRequest;
  const { url, selector, extractJsonLd = false, timeout = 30000 } = body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
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
  if (isBlockedUrl(parsedUrl.hostname)) {
    return res.status(403).json({ success: false, error: 'Access to this URL is not allowed' });
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0; +https://code-agent.app)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5,zh-CN;q=0.3',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';
    const html = await response.text();
    const responseTime = Date.now() - startTime;

    // 解析 HTML
    const parsed = parseHtml(html);

    // 构建结果
    const result: ScrapeResult = {
      url,
      title: parsed.title,
      content: parsed.content.slice(0, 10000), // 限制内容长度
      metadata: {
        statusCode: response.status,
        contentType,
        responseTime,
      },
    };

    // 选择器提取
    if (selector) {
      const selected = querySelector(html, selector);
      if (selected.length > 0) {
        result.extractedData = {
          selector,
          results: selected.join('\n---\n'),
        };
        result.content = selected.join('\n\n');
      }
    }

    // JSON-LD 提取
    if (extractJsonLd && parsed.jsonLd.length > 0) {
      result.jsonLd = parsed.jsonLd;
    }

    return res.status(200).json({
      success: true,
      data: result,
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
      error: err.message || 'Failed to fetch URL',
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

  return handleScrape(req, res);
}
