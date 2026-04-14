// ============================================================================
// Web Search Tool - Multi-source parallel web search
// Supports: Cloud Proxy, Perplexity, EXA, Brave Search
// P1: Domain filtering (allowed_domains / blocked_domains)
// P2: Auto-extract (search + fetch + AI extraction)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConfigService } from '../../services/core/configService';
import { createLogger } from '../../services/infra/logger';

import type { DomainFilter, SearchResult } from './search/searchTypes';
import {
  formatAsTable,
  deduplicateResults,
} from './search/searchUtils';
import {
  routeSources,
  getAvailableSources,
} from './search/searchStrategies';
import {
  parallelSearch,
  serialSearch,
} from './search/searchOrchestrator';
import {
  autoExtractFromResults,
  autoExtractFallback,
} from './search/contentExtractor';

// Re-export public API so existing consumers (tests, index.ts) keep working
export {
  formatAge,
  formatAsTable,
  buildDomainQuerySuffix,
  mergeSearchResults,
  deduplicateResults,
  normalizeTitleForDedup,
} from './search';

const logger = createLogger('WebSearch');

// ============================================================================
// Tool Definition
// ============================================================================

export const webSearchTool: Tool = {
  name: 'WebSearch',
  description: 'Searches the web for information. Use for finding documentation, researching APIs, checking current facts, or answering questions that require up-to-date information. Returns search results with titles, URLs, and snippets.',
  dynamicDescription: () => {
    const now = new Date();
    const currentDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const currentYear = now.getFullYear();
    return `Search the web and return results with titles, URLs, and snippets.

Provides up-to-date information beyond the model's knowledge cutoff. Use when you need current data, recent events, or documentation updates.

IMPORTANT: 当前日期为 ${currentDate}。搜索时务必使用正确的年份 ${currentYear}，不要搜索过时的年份。

CRITICAL: After answering with search results, you MUST include a "Sources:" section listing relevant URLs as markdown hyperlinks.

Use for: finding documentation, researching APIs, looking up error messages, discovering libraries, current events.
For reading a specific URL you already have, use WebFetch instead.
For searching local code, use grep or glob.

Features:
- Intelligent source routing: automatically picks 2-3 best-fit sources based on query characteristics
- mode: "quick" (2 sources, fast) or "research" (3-4 sources, thorough)
- Parallel search across multiple sources (Perplexity, EXA, Brave, Tavily)
- Domain filtering with allowed_domains / blocked_domains
- auto_extract: search + fetch + AI extraction in one call
- recency: filter results by day/week/month
- output_format: "table" for compact markdown output`;
  },
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
        description: 'Number of results to return per source (default: 5, max: 10)',
      },
      parallel: {
        type: 'boolean',
        description: 'Enable parallel search across all available sources (default: true)',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific sources to use: cloud, perplexity, exa, brave (default: all available)',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains (e.g., ["docs.python.org", "github.com"])',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains (e.g., ["pinterest.com", "quora.com"])',
      },
      auto_extract: {
        type: 'boolean',
        description: 'After search, auto-fetch top results and extract content (default: false)',
      },
      extract_count: {
        type: 'number',
        description: 'Number of results to auto-extract (default: 3, max: 5)',
      },
      recency: {
        type: 'string',
        description: 'Time filter: "day" (past 24h), "week" (past 7 days), "month" (past 30 days). Only returns results published within this window.',
      },
      output_format: {
        type: 'string',
        description: 'Output format: "default" (detailed with snippets) or "table" (compact markdown table ready to copy-paste). Use "table" when you need to directly include results in a report.',
      },
      mode: {
        type: 'string',
        enum: ['quick', 'research'],
        description: 'Search mode: "quick" uses 2 best-fit sources for speed, "research" uses 3-4 sources for thoroughness. Default: "quick".',
      },
      save_to: {
        type: 'string',
        description: 'File path to automatically save results. The tool writes the file directly — no need to call Write separately.',
      },
      language: {
        type: 'string',
        description: 'Output language for results. When set (e.g., "zh"), titles and snippets are translated at the tool level. Requires output_format="table".',
      },
    },
    required: ['query'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const count = Math.min(Math.max((params.count as number) || 5, 1), 10);
    const parallel = (params.parallel as boolean) ?? true;
    const requestedSources = params.sources as string[] | undefined;
    const mode = (params.mode as 'quick' | 'research') || 'quick';
    const autoExtract = params.auto_extract !== undefined
      ? Boolean(params.auto_extract)
      : mode === 'research'; // research 模式默认开启
    const extractCount = Math.min(Math.max((params.extract_count as number) || (mode === 'research' ? 3 : 1), 1), 5);
    const recency = params.recency as string | undefined;
    const outputFormat = (params.output_format as string) || 'default';
    const language = params.language as string | undefined;

    // Build domain filter
    const domainFilter: DomainFilter | undefined =
      (params.allowed_domains || params.blocked_domains)
        ? {
            allowed: params.allowed_domains as string[] | undefined,
            blocked: params.blocked_domains as string[] | undefined,
          }
        : undefined;

    const configService = getConfigService();

    // Get all sources with configured API keys
    const allAvailable = getAvailableSources(configService);

    if (allAvailable.length === 0) {
      return {
        success: false,
        error: 'No search sources available. Please configure at least one API key (EXA, Perplexity, or Brave) in Settings > Service API Keys.',
      };
    }

    // Intelligent source routing: analyze query to pick best-fit sources
    const routing = routeSources(query, { mode, requestedSources });

    // Intersect: only use routed sources that are actually available
    const routedAvailable = allAvailable.filter(s => routing.sources.includes(s.name));

    // If routing filtered everything out, fallback to all available
    const availableSources = routedAvailable.length > 0 ? routedAvailable : allAvailable;

    logger.info('Search source routing', {
      query: query.substring(0, 50),
      routed: routing.sources,
      reason: routing.reason,
      available: allAvailable.map(s => s.name),
      final: availableSources.map(s => s.name),
    });

    let searchResult: ToolExecutionResult;

    if (parallel && availableSources.length > 1) {
      searchResult = await parallelSearch(query, count, availableSources, configService, domainFilter, recency);
    } else {
      searchResult = await serialSearch(query, count, availableSources, configService, domainFilter, recency);
    }

    // Deduplicate results (handles same article from different sites)
    if (searchResult.success) {
      deduplicateResults(searchResult);
    }

    // P2: Auto-extract content from top results
    if (autoExtract && searchResult.success) {
      if (context.modelCallback) {
        // Electron mode: AI extraction via modelCallback
        const extractedContent = await autoExtractFromResults(
          searchResult,
          query,
          extractCount,
          context.modelCallback,
        );
        if (extractedContent) {
          searchResult.output = (searchResult.output || '') + '\n\n' + extractedContent;
        }
      } else {
        // CLI mode fallback: fetch + smartTruncate (no AI, but real page content)
        const extractedContent = await autoExtractFallback(
          searchResult,
          extractCount,
        );
        if (extractedContent) {
          searchResult.output = (searchResult.output || '') + '\n\n' + extractedContent;
        }
      }
    }

    // Convert to table format if requested
    if (outputFormat === 'table' && searchResult.success) {
      searchResult.output = formatAsTable(searchResult);
    }

    // Translate results at tool level if language is specified
    if (language && searchResult.success && searchResult.output) {
      // Skip translation when query language already matches target language
      const queryText = (params.query as string) || '';
      const hasChinese = /[\u4e00-\u9fff]/.test(queryText);
      const isAllEnglish = /^[a-zA-Z0-9\s\-_.,;:!?'"()\[\]{}<>@#$%^&*+=|/\\~`]+$/.test(queryText);
      const skipTranslation =
        (language === 'zh' && hasChinese) ||
        (language === 'en' && isAllEnglish);

      if (skipTranslation) {
        logger.debug('Skipping translation - query language matches target', { language, query: queryText });
      }

      const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
      const results = resultData?.results || [];
      if (!skipTranslation && results.length > 0) {
        try {
          // Use quick model (fast & free) for translation instead of main model
          const { quickTask, isQuickModelAvailable } = await import('../../model/quickModel');
          if (!isQuickModelAvailable() && !context.modelCallback) {
            logger.warn('No model available for translation, skipping');
          }
          // Batch translate: send all titles+snippets in one call
          const items = results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || r.description || ''}`).join('\n---\n');
          const prompt = `Translate the following search result titles and descriptions to ${language === 'zh' ? 'Chinese (简体中文)' : language}. Keep the numbering. Only output the translations, one per item, separated by ---:\n\n${items}`;

          let translated: string | undefined;
          if (isQuickModelAvailable()) {
            const result = await quickTask(prompt);
            translated = result.success ? result.content : undefined;
            if (!result.success) {
              logger.warn('Quick model translation failed, falling back to modelCallback', { error: result.error });
              // Fallback to modelCallback if quick model fails
              if (context.modelCallback) {
                translated = await context.modelCallback(prompt);
              }
            }
          } else if (context.modelCallback) {
            // Fallback: use modelCallback if quick model not available
            translated = await context.modelCallback(prompt);
          }

          if (translated) {
            // Parse translated items and rebuild output
            const translatedItems = translated.split('---').map(s => s.trim()).filter(Boolean);
            const lines: string[] = [];
            results.forEach((item, i) => {
              const tItem = translatedItems[i] || '';
              // Extract translated title (first line) and description (rest)
              const tLines = tItem.split('\n').filter(Boolean);
              const tTitle = tLines[0]?.replace(/^\d+\.\s*/, '') || item.title;
              const tDesc = tLines.slice(1).join(' ') || item.snippet || item.description || '';
              const age = item.age ? ` (${item.age})` : '';
              lines.push(`### ${i + 1}. ${tTitle.substring(0, 100)}${age}`);
              if (tDesc) lines.push(tDesc.substring(0, 200));
              lines.push(item.url);
              lines.push('');
            });
            searchResult.output = lines.join('\n');
            logger.info(`Translated ${results.length} results to ${language}`);
          }
        } catch (err) {
          logger.warn(`Translation failed, keeping original language:`, err instanceof Error ? err.message : err);
        }
      }
    }

    // Save to file if requested (bypasses model — writes directly)
    const saveTo = params.save_to as string | undefined;
    if (saveTo && searchResult.success && searchResult.output) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const resolvedPath = saveTo.replace(/^~/, process.env.HOME || '');
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Add header with today's date and query
        const today = new Date().toISOString().slice(0, 10);
        const fileContent = `# 搜索结果 - ${today}\n\n查询: ${query}\n\n${searchResult.output}`;
        fs.writeFileSync(resolvedPath, fileContent, 'utf8');
        searchResult.output += `\n\n✅ Results saved to: ${resolvedPath}`;
        logger.info(`Search results saved to: ${resolvedPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        searchResult.output += `\n\n⚠️ Failed to save: ${msg}`;
        logger.warn(`Failed to save results to ${saveTo}:`, msg);
      }
    }

    return searchResult;
  },
};
