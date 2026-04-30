// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
// dynamicDescription is inlined as a pure function (no legacy deps).
import type { ToolSchema } from '../../../protocol/tools';

export const webSearchSchema: ToolSchema = {
  name: 'WebSearch',
  description:
    'Searches the web for information. REQUIRED parameter: `query` (non-empty string — do not call without it). Use for finding documentation, researching APIs, checking current facts, or answering questions that require up-to-date information. Returns search results with titles, URLs, and snippets. Stop once the returned results are enough; do not repeat the same search just to add more sources.',
  dynamicDescription: () => {
    const now = new Date();
    const currentDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const currentYear = now.getFullYear();
    return `Search the web and return results with titles, URLs, and snippets.

Provides up-to-date information beyond the model's knowledge cutoff. Use when you need current data, recent events, or documentation updates.

IMPORTANT: 当前日期为 ${currentDate}。搜索时务必使用正确的年份 ${currentYear}，不要搜索过时的年份。

CRITICAL: After answering with search results, you MUST include a "Sources:" section listing relevant URLs as markdown hyperlinks.

Use for: finding documentation, researching APIs, looking up error messages, discovering libraries, current events.
For reading a specific URL you already have, use WebFetch with {"action":"fetch","url":"https://...","prompt":"..."}.
For searching local code, use grep or glob.

Do not repeatedly search or fetch when the current results already answer the question. If you need page contents for top results, prefer auto_extract instead of doing a separate WebFetch loop over every result.

Features:
- Intelligent source routing: automatically picks 2-3 best-fit sources based on query characteristics
- mode: "quick" (2 sources, fast) or "research" (3-4 sources, thorough)
- Parallel search across multiple sources (Perplexity, EXA, Brave, Tavily)
- Domain filtering with allowed_domains / blocked_domains
- auto_extract: search + fetch + AI extraction in one call
- recency: filter results by day/week/month
- output_format: "table" for compact markdown output`;
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. REQUIRED and must be a non-empty string. Never omit or pass an empty value.',
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
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
