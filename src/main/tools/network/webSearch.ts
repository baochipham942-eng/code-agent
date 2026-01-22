// ============================================================================
// Web Search Tool - Search the web using Cloud Proxy or Brave Search API
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services/core/configService';

const CLOUD_SEARCH_URL = 'https://code-agent-beta.vercel.app/api/tools?action=search';
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  description?: string;
  age?: string;
}

interface CloudSearchResponse {
  success: boolean;
  query: string;
  results?: SearchResult[];
  answer?: string;
  citations?: string[];
  source: 'perplexity' | 'brave';
  error?: string;
}

interface BraveSearchResponse {
  web?: {
    results: SearchResult[];
  };
  query?: {
    original: string;
  };
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for information. Useful for finding documentation, error solutions, best practices, and recent information beyond training data.',
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (default: 5, max: 20)',
      },
    },
    required: ['query'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const count = Math.min(Math.max((params.count as number) || 5, 1), 20);

    // Try cloud proxy first (uses server-side API keys)
    try {
      const cloudResult = await searchViaCloud(query, count);
      if (cloudResult.success) {
        return cloudResult;
      }
      // Cloud failed, fall through to local
    } catch {
      // Cloud unavailable, fall through to local
    }

    // Fallback to local Brave API if user has configured a key
    const configService = getConfigService();
    const apiKey = configService?.getServiceApiKey('brave') || process.env.BRAVE_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: 'Search service temporarily unavailable. Cloud proxy failed and no local Brave API Key configured.',
      };
    }

    return searchViaBrave(query, count, apiKey);
  },
};

/**
 * Search via cloud proxy (recommended - uses server-side API keys)
 */
async function searchViaCloud(query: string, maxResults: number): Promise<ToolExecutionResult> {
  const response = await fetch(CLOUD_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, maxResults }),
  });

  if (!response.ok) {
    return {
      success: false,
      error: `Cloud search failed: ${response.status}`,
    };
  }

  const data = await response.json() as CloudSearchResponse;

  if (!data.success) {
    return {
      success: false,
      error: data.error || 'Cloud search failed',
    };
  }

  // Format results based on source
  if (data.source === 'perplexity' && data.answer) {
    // Perplexity returns an AI-generated answer with citations
    let output = `Search results for: "${query}" (via Perplexity AI)\n\n${data.answer}`;
    if (data.citations && data.citations.length > 0) {
      output += '\n\nSources:\n' + data.citations.map((c, i) => `${i + 1}. ${c}`).join('\n');
    }
    return {
      success: true,
      output,
      result: { answer: data.answer, citations: data.citations },
    };
  }

  // Brave returns traditional search results
  const results = data.results || [];
  if (results.length === 0) {
    return {
      success: true,
      output: `No results found for: "${query}"`,
    };
  }

  const formattedResults = results.map((result, index) => {
    const snippet = result.snippet || result.description || '';
    return `${index + 1}. ${result.title}\n   ${result.url}\n   ${snippet}`;
  }).join('\n\n');

  return {
    success: true,
    output: `Search results for: "${query}"\n\n${formattedResults}`,
    result: results,
  };
}

/**
 * Search via local Brave API (fallback when cloud is unavailable)
 */
async function searchViaBrave(query: string, count: number, apiKey: string): Promise<ToolExecutionResult> {
  try {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', count.toString());

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Brave Search API error: ${response.status} ${response.statusText}\n${errorText}`,
      };
    }

    const data = await response.json() as BraveSearchResponse;
    const results = data.web?.results || [];

    if (results.length === 0) {
      return {
        success: true,
        output: `No results found for: "${query}"`,
      };
    }

    const formattedResults = results.map((result, index) => {
      const age = result.age ? ` (${result.age})` : '';
      return `${index + 1}. ${result.title}${age}\n   ${result.url}\n   ${result.description || ''}`;
    }).join('\n\n');

    return {
      success: true,
      output: `Search results for: "${query}"\n\n${formattedResults}`,
      result: results,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: `Web search failed: ${message}`,
    };
  }
}
