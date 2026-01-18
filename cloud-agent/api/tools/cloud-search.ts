// ============================================================================
// cloud_search - 搜索工具（DuckDuckGo）
// POST /api/tools/cloud-search
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  maxDuration: 30,
};

interface SearchRequest {
  query: string;
  maxResults?: number;
  region?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/**
 * DuckDuckGo HTML 搜索
 * 使用 DuckDuckGo 的 HTML 版本避免 API 限制
 */
async function searchDuckDuckGo(
  query: string,
  maxResults: number = 10,
  region: string = ''
): Promise<SearchResult[]> {
  // DuckDuckGo HTML 搜索 URL
  const params = new URLSearchParams({
    q: query,
    kl: region || '', // 区域设置
  });

  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }

  const html = await response.text();

  // 解析搜索结果
  const results: SearchResult[] = [];

  // 匹配搜索结果块
  // DuckDuckGo HTML 结果格式: <a class="result__a" href="...">Title</a> ... <a class="result__snippet">Snippet</a>
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/gi;

  let match;
  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    let matchedUrl = match[1];
    const title = match[2].trim();
    const snippet = match[3]
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // DuckDuckGo 会对 URL 进行编码，需要解码
    if (matchedUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        const uddg = new URL('https:' + matchedUrl).searchParams.get('uddg');
        if (uddg) {
          matchedUrl = decodeURIComponent(uddg);
        }
      } catch {
        // 保持原 URL
      }
    }

    if (title && matchedUrl) {
      results.push({
        title,
        url: matchedUrl,
        snippet,
        source: new URL(matchedUrl).hostname,
      });
    }
  }

  // 如果正则匹配失败，尝试备用解析
  if (results.length === 0) {
    // 备用解析：查找链接和标题
    const linkPattern = /<a[^>]*class="[^"]*result[^"]*"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
    while ((match = linkPattern.exec(html)) !== null && results.length < maxResults) {
      let matchedUrl = match[1];
      const title = match[2].trim();

      // 过滤非搜索结果链接
      if (matchedUrl.includes('duckduckgo.com') && !matchedUrl.includes('uddg=')) {
        continue;
      }

      // 解码 URL
      if (matchedUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
        try {
          const uddg = new URL('https:' + matchedUrl).searchParams.get('uddg');
          if (uddg) {
            matchedUrl = decodeURIComponent(uddg);
          }
        } catch {
          continue;
        }
      }

      if (title && matchedUrl && !matchedUrl.startsWith('//duckduckgo.com')) {
        results.push({
          title,
          url: matchedUrl,
          snippet: '',
          source: new URL(matchedUrl).hostname,
        });
      }
    }
  }

  return results;
}

/**
 * DuckDuckGo Instant Answer API (备用)
 */
async function searchDuckDuckGoApi(query: string): Promise<{
  abstract?: string;
  abstractSource?: string;
  abstractUrl?: string;
  relatedTopics?: Array<{ text: string; url: string }>;
}> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  });

  const apiUrl = `https://api.duckduckgo.com/?${params.toString()}`;

  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'CodeAgent/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo API failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    abstract: data.Abstract,
    abstractSource: data.AbstractSource,
    abstractUrl: data.AbstractURL,
    relatedTopics: data.RelatedTopics?.filter((t: Record<string, unknown>) => t.Text && t.FirstURL)
      .map((t: Record<string, unknown>) => ({
        text: t.Text as string,
        url: t.FirstURL as string,
      })),
  };
}

async function handleSearch(req: VercelRequest, res: VercelResponse) {
  const body = req.body as SearchRequest;
  const { query, maxResults = 10, region = '' } = body;

  if (!query) {
    return res.status(400).json({ success: false, error: 'Query is required' });
  }

  const startTime = Date.now();

  try {
    // 并行请求 HTML 搜索和 Instant Answer API
    const [searchResults, instantAnswer] = await Promise.all([
      searchDuckDuckGo(query, maxResults, region),
      searchDuckDuckGoApi(query).catch(() => null), // Instant Answer 失败不影响主搜索
    ]);

    const responseData: {
      success: boolean;
      query: string;
      results: SearchResult[];
      instantAnswer?: {
        abstract: string;
        source: string;
        url: string;
      };
      relatedTopics?: Array<{ text: string; url: string }>;
      duration: number;
    } = {
      success: true,
      query,
      results: searchResults,
      duration: Date.now() - startTime,
    };

    // 添加 Instant Answer
    if (instantAnswer?.abstract) {
      responseData.instantAnswer = {
        abstract: instantAnswer.abstract,
        source: instantAnswer.abstractSource || '',
        url: instantAnswer.abstractUrl || '',
      };
    }

    // 添加相关主题
    if (instantAnswer?.relatedTopics && instantAnswer.relatedTopics.length > 0) {
      responseData.relatedTopics = instantAnswer.relatedTopics.slice(0, 5);
    }

    return res.status(200).json(responseData);
  } catch (error: unknown) {
    const err = error as Error;
    return res.status(500).json({
      success: false,
      error: err.message || 'Search failed',
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

  return handleSearch(req, res);
}
