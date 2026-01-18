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
 * Brave Search API (免费版每月 2000 次)
 */
async function searchBrave(
  query: string,
  apiKey: string,
  maxResults: number = 10
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(maxResults, 20)),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search failed: ${response.status}`);
  }

  const data = await response.json() as {
    web?: {
      results?: Array<{
        title: string;
        url: string;
        description?: string;
      }>;
    };
  };

  return (data.web?.results || []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description || '',
    source: new URL(r.url).hostname,
  }));
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
  }

  // Brave Search API Key (免费版作为备用)
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;

  try {
    let responseData: {
      success: boolean;
      query: string;
      results: SearchResult[];
      answer?: string;
      source: 'perplexity' | 'brave';
      duration: number;
    };

    if (perplexityKey) {
      // 使用 Perplexity API（已登录用户）
      const { results, answer } = await searchWithPerplexity(query, perplexityKey, focus, maxResults);
      responseData = {
        success: true,
        query,
        results,
        answer,
        source: 'perplexity',
        duration: Date.now() - startTime,
      };
    } else if (braveApiKey) {
      // 使用 Brave Search（免费备用）
      const results = await searchBrave(query, braveApiKey, maxResults);
      responseData = {
        success: true,
        query,
        results,
        source: 'brave',
        duration: Date.now() - startTime,
      };
    } else {
      return res.status(503).json({
        success: false,
        error: 'No search API available. Please login or configure API keys.',
        duration: Date.now() - startTime,
      });
    }

    return res.status(200).json(responseData);
  } catch (error: unknown) {
    const err = error as Error;

    // 如果 Perplexity 失败，尝试回退到 Brave
    if (perplexityKey && braveApiKey) {
      try {
        const results = await searchBrave(query, braveApiKey, maxResults);
        return res.status(200).json({
          success: true,
          query,
          results,
          source: 'brave',
          fallback: true,
          originalError: err.message,
          duration: Date.now() - startTime,
        });
      } catch {
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
