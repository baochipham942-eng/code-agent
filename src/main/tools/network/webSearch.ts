// ============================================================================
// Web Search Tool - Search the web using Brave Search API
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services/core/configService';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveSearchResult[];
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

    const configService = getConfigService();
    const apiKey = configService?.getServiceApiKey('brave') || process.env.BRAVE_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        error: 'Brave API Key not configured. Please set it in Settings > API Keys or in your .env file.',
      };
    }

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

      // Format results
      const formattedResults = results.map((result, index) => {
        const age = result.age ? ` (${result.age})` : '';
        return `${index + 1}. ${result.title}${age}\n   ${result.url}\n   ${result.description}`;
      }).join('\n\n');

      return {
        success: true,
        output: `Search results for: "${query}"\n\n${formattedResults}`,
        result: results, // For caching
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Web search failed: ${message}`,
      };
    }
  },
};
