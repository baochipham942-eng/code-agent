// ============================================================================
// cloud_search - 搜索工具（Perplexity API）
// POST /api/tools/cloud-search
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth.js';
import { getApiKey } from '../../lib/apiKeys.js';

export const config = {
  maxDuration: 30,
};

interface SearchRequest {
  query: string;
  maxResults?: number;
  focus?: 'internet' | 'scholar' | 'writing' | 'wolfram' | 'youtube' | 'reddit';
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/**
 * 使用 Perplexity API 进行搜索
 */
async function searchWithPerplexity(
  query: string,
  apiKey: string,
  focus: string = 'internet',
  maxResults: number = 10
): Promise<{ results: SearchResult[]; answer?: string }> {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: `You are a search assistant. Search the web and provide relevant information. Focus: ${focus}`,
        },
        {
          role: 'user',
          content: query,
        },
      ],
      max_tokens: 1024,
      return_citations: true,
      return_related_questions: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Perplexity API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const answer = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];

  // 将 citations 转换为搜索结果格式
  const results: SearchResult[] = citations.slice(0, maxResults).map((url: string, index: number) => {
    try {
      const urlObj = new URL(url);
      return {
        title: `Source ${index + 1}`,
        url,
        snippet: '',
        source: urlObj.hostname,
      };
    } catch {
      return {
        title: `Source ${index + 1}`,
        url,
        snippet: '',
      };
    }
  });

  return { results, answer };
}

/**
 * DuckDuckGo HTML 搜索 (备用方案，不需要 API Key)
 */
async function searchDuckDuckGo(
  query: string,
  maxResults: number = 10
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, kl: '' });
  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];

  // 简单解析
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    let matchedUrl = match[1];
    const title = match[2].trim();

    if (matchedUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        const uddg = new URL('https:' + matchedUrl).searchParams.get('uddg');
        if (uddg) matchedUrl = decodeURIComponent(uddg);
      } catch {
        continue;
      }
    }

    if (title && matchedUrl && !matchedUrl.includes('duckduckgo.com')) {
      results.push({
        title,
        url: matchedUrl,
        snippet: '',
        source: new URL(matchedUrl).hostname,
      });
    }
  }

  return results;
}

async function handleSearch(req: VercelRequest, res: VercelResponse) {
  const body = req.body as SearchRequest;
  const { query, maxResults = 10, focus = 'internet' } = body;

  if (!query) {
    return res.status(400).json({ success: false, error: 'Query is required' });
  }

  const startTime = Date.now();

  // 尝试获取用户身份
  const authPayload = await authenticateRequest(req.headers.authorization);
  let perplexityKey: string | null = null;

  if (authPayload) {
    // 已登录用户，根据权限获取 Key
    const keyResult = await getApiKey(authPayload.userId, 'perplexity');
    if (keyResult) {
      perplexityKey = keyResult.key;
    }
  } else {
    // 未登录用户，不提供系统 Key（除非是公开 API）
    // 可以考虑提供有限的免费额度
  }

  try {
    let responseData: {
      success: boolean;
      query: string;
      results: SearchResult[];
      answer?: string;
      source: 'perplexity' | 'duckduckgo';
      duration: number;
    };

    if (perplexityKey) {
      // 使用 Perplexity API
      const { results, answer } = await searchWithPerplexity(query, perplexityKey, focus, maxResults);
      responseData = {
        success: true,
        query,
        results,
        answer,
        source: 'perplexity',
        duration: Date.now() - startTime,
      };
    } else {
      // 回退到 DuckDuckGo
      const results = await searchDuckDuckGo(query, maxResults);
      responseData = {
        success: true,
        query,
        results,
        source: 'duckduckgo',
        duration: Date.now() - startTime,
      };
    }

    return res.status(200).json(responseData);
  } catch (error: unknown) {
    const err = error as Error;

    // 如果 Perplexity 失败，尝试回退到 DuckDuckGo
    if (perplexityKey) {
      try {
        const results = await searchDuckDuckGo(query, maxResults);
        return res.status(200).json({
          success: true,
          query,
          results,
          source: 'duckduckgo',
          fallback: true,
          originalError: err.message,
          duration: Date.now() - startTime,
        });
      } catch (fallbackError) {
        // 两者都失败
      }
    }

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
