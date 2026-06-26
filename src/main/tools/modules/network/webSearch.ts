// ============================================================================
// WebSearch (Level 2 native module)
//
// Directly uses search routing/orchestration modules instead of delegating to
// legacy webSearchTool. Legacy markdown output remains compatible, while native
// meta exposes structured results and artifact metadata.
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getConfigService } from '../../../services/core/configService';
import type { ToolExecutionResult } from '../../types';
import type { DomainFilter, SearchResult } from '../../web/search';
import {
  routeSources,
  getAvailableSources,
  parallelSearch,
  serialSearch,
  deduplicateResults,
  formatAsTable,
  getCircuitBreakerRemaining,
  SEARCH_PROVIDER_SETUP_MESSAGE,
  SEARCH_FAILURE_GUIDANCE,
  buildSearchPlan,
  rankSearchResultData,
  type SearchPlan,
  type PlannedSearchQuery,
} from '../../web/search';
import {
  autoExtractFromResults,
  autoExtractFallback,
} from '../../web/search/contentExtractor';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { webSearchSchema as schema } from './webSearch.schema';

function resolveSavePath(input: string, workingDir: string): string {
  const expanded = input.startsWith('~/')
    ? path.join(os.homedir(), input.slice(2))
    : input.replace(/^~$/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.join(workingDir, expanded);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function getResultData(searchResult: ToolExecutionResult): {
  results: SearchResult[];
  sources: string[];
  duration?: number;
} {
  const resultData = searchResult.result as {
    results?: SearchResult[];
    source?: string;
    sources?: string[];
    duration?: number;
  } | undefined;
  const results = resultData?.results ?? [];
  const sources = resultData?.sources ?? (resultData?.source ? [resultData.source] : []);
  return { results, sources, duration: resultData?.duration };
}

const RECENCY_ENFORCED_SOURCES = new Set([
  'firecrawl',
  'firecrawl-keyless',
  'exa',
  'brave',
  'tavily',
]);
const RECENCY_BEST_EFFORT_SOURCES = new Set(['openai']);

function uniqueSourceNames(sources: string[]): string[] {
  return Array.from(new Set(sources.filter(Boolean)));
}

function buildRecencyMeta(recency: string | undefined, sources: string[]): {
  recencyRequested: boolean;
  recencyEnforcedBy: string[];
  recencyBestEffortBy: string[];
} {
  if (!recency) {
    return {
      recencyRequested: false,
      recencyEnforcedBy: [],
      recencyBestEffortBy: [],
    };
  }
  const uniqueSources = uniqueSourceNames(sources);
  return {
    recencyRequested: true,
    recencyEnforcedBy: uniqueSources.filter(source => RECENCY_ENFORCED_SOURCES.has(source)),
    recencyBestEffortBy: uniqueSources.filter(source => RECENCY_BEST_EFFORT_SOURCES.has(source)),
  };
}

function mergePlannedSearchResults(
  originalQuery: string,
  queryPlan: SearchPlan,
  results: Array<{ plannedQuery: PlannedSearchQuery; result: ToolExecutionResult }>,
): ToolExecutionResult {
  const outputParts: string[] = [
    `# Search results for: "${originalQuery}"`,
    `Search plan: ${queryPlan.intent} (${results.length}/${queryPlan.queries.length} queries succeeded)`,
    '',
  ];
  const mergedResults: SearchResult[] = [];
  const mergedSources: string[] = [];
  let duration = 0;

  for (const item of results) {
    const resultData = getResultData(item.result);
    mergedResults.push(...resultData.results);
    mergedSources.push(...resultData.sources);
    duration += resultData.duration ?? 0;
    outputParts.push(`## Query: ${item.plannedQuery.query}`);
    if (item.result.output) outputParts.push(item.result.output);
    outputParts.push('');
  }

  const merged: ToolExecutionResult = {
    success: true,
    output: outputParts.join('\n'),
    result: {
      results: mergedResults,
      sources: uniqueSourceNames(mergedSources),
      duration,
      queryPlan,
    },
  };
  deduplicateResults(merged);
  rankSearchResultData(merged);
  return merged;
}

async function translateOutputIfNeeded(
  searchResult: ToolExecutionResult,
  query: string,
  language: string | undefined,
  modelCallback: ToolContext['modelCallback'],
  logger: ToolContext['logger'],
): Promise<void> {
  if (!language || !searchResult.success || !searchResult.output) return;

  const { results } = getResultData(searchResult);
  if (results.length === 0) return;

  const hasChinese = /[\u4e00-\u9fff]/.test(query);
  const isAllEnglish = /^[a-zA-Z0-9\s\-_.,;:!?'"()[\]{}<>@#$%^&*+=|/\\~`]+$/.test(query);
  const skipTranslation =
    (language === 'zh' && hasChinese) ||
    (language === 'en' && isAllEnglish);

  if (skipTranslation) {
    logger.debug('Skipping WebSearch translation - query language matches target', { language, query });
    return;
  }

  try {
    const { quickTask, isQuickModelAvailable } = await import('../../../model/quickModel');
    const items = results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || r.description || ''}`).join('\n---\n');
    const prompt = `Translate the following search result titles and descriptions to ${language === 'zh' ? 'Chinese (简体中文)' : language}. Keep the numbering. Only output the translations, one per item, separated by ---:\n\n${items}`;

    let translated: string | undefined;
    if (isQuickModelAvailable()) {
      const result = await quickTask(prompt);
      translated = result.success ? result.content : undefined;
      if (!result.success) {
        logger.warn('Quick model WebSearch translation failed, falling back to modelCallback', { error: result.error });
        if (modelCallback) translated = await modelCallback(prompt);
      }
    } else if (modelCallback) {
      translated = await modelCallback(prompt);
    }

    if (!translated) return;

    const translatedItems = translated.split('---').map(s => s.trim()).filter(Boolean);
    const lines: string[] = [];
    results.forEach((item, i) => {
      const tItem = translatedItems[i] || '';
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
    logger.info('Translated WebSearch results', { count: results.length, language });
  } catch (err) {
    logger.warn('WebSearch translation failed, keeping original language', err instanceof Error ? err.message : err);
  }
}

async function saveSearchOutput(saveTo: string, workingDir: string, query: string, output: string): Promise<string> {
  const resolvedPath = resolveSavePath(saveTo, workingDir);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const today = new Date().toISOString().slice(0, 10);
  const fileContent = `# 搜索结果 - ${today}\n\n查询: ${query}\n\n${output}`;
  fs.writeFileSync(resolvedPath, fileContent, 'utf8');
  return resolvedPath;
}

class WebSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const query = typeof args.query === 'string' ? args.query : undefined;
    if (!query || query.length === 0) {
      return { ok: false, error: 'WebSearch 需要 query 参数（非空字符串）', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: query ? `WebSearch ${query.slice(0, 40)}` : 'WebSearch' });

    const count = Math.min(Math.max((args.count as number | undefined) || 5, 1), 10);
    const parallel = (args.parallel as boolean | undefined) ?? true;
    const requestedSources = asStringArray(args.sources);
    const mode = (args.mode as 'quick' | 'research' | undefined) || 'quick';
    const autoExtract = args.auto_extract !== undefined
      ? Boolean(args.auto_extract)
      : mode === 'research';
    const extractCount = Math.min(Math.max((args.extract_count as number | undefined) || (mode === 'research' ? 3 : 1), 1), 5);
    const recency = args.recency as string | undefined;
    const outputFormat = (args.output_format as string | undefined) || 'default';
    const language = args.language as string | undefined;

    const allowedDomains = asStringArray(args.allowed_domains);
    const blockedDomains = asStringArray(args.blocked_domains);
    const domainFilter: DomainFilter | undefined =
      (allowedDomains || blockedDomains)
        ? { allowed: allowedDomains, blocked: blockedDomains }
        : undefined;

    const configService = getConfigService();
    // 应用用户搜索源偏好（ADR-026：启停 + 优先级），与 Level 1 WebSearch 路径保持一致
    const searchPrefs = configService.getSettings().search;
    const allAvailable = getAvailableSources(configService, undefined, searchPrefs);

    if (allAvailable.length === 0) {
      return {
        ok: false,
        error: SEARCH_PROVIDER_SETUP_MESSAGE,
        code: 'NO_SEARCH_SOURCE',
      };
    }

    const queryPlan = buildSearchPlan(query, { mode, requestedSources });
    const routing = routeSources(query, { mode, requestedSources });
    const routedAvailable = allAvailable.filter(s => routing.sources.includes(s.name));

    // Quota-aware ordering: a source that recently returned 401/402/432/quota gets a
    // circuit-breaker cooldown. Don't keep selecting exhausted sources every round —
    // demote them and backfill with other healthy sources so we don't under-search.
    const isHealthy = (s: typeof allAvailable[number]) => getCircuitBreakerRemaining(s.name) === 0;
    const healthyRouted = routedAvailable.filter(isHealthy);
    let availableSources: typeof allAvailable;
    if (routedAvailable.length === 0) {
      // Routing matched nothing available → fall back to any healthy source, else all.
      const healthyAll = allAvailable.filter(isHealthy);
      availableSources = healthyAll.length > 0 ? healthyAll : allAvailable;
    } else if (healthyRouted.length === routedAvailable.length) {
      // All routed sources are healthy → respect the routing as-is.
      availableSources = routedAvailable;
    } else if (healthyRouted.length > 0) {
      // Some routed sources are exhausted → keep the healthy ones, backfill with other
      // healthy available sources that routing didn't pick.
      const backfill = allAvailable.filter(s => isHealthy(s) && !healthyRouted.includes(s));
      availableSources = [...healthyRouted, ...backfill];
    } else {
      // Every routed source is exhausted → try any other healthy source before giving up.
      const healthyAll = allAvailable.filter(isHealthy);
      availableSources = healthyAll.length > 0 ? healthyAll : routedAvailable;
    }
    const routingMeta = {
      requested: requestedSources,
      routed: routing.sources,
      reason: routing.reason,
      available: allAvailable.map(s => s.name),
      skipped: allAvailable.filter(s => !isHealthy(s)).map(s => s.name),
      final: availableSources.map(s => s.name),
    };

    ctx.logger.info('WebSearch source routing', {
      query: query.substring(0, 80),
      ...routingMeta,
    });

    const successfulSearches: Array<{ plannedQuery: PlannedSearchQuery; result: ToolExecutionResult }> = [];
    const failedSearches: string[] = [];
    for (const plannedQuery of queryPlan.queries) {
      const result = parallel && availableSources.length > 1
        ? await parallelSearch(plannedQuery.query, count, availableSources, configService, domainFilter, recency)
        : await serialSearch(plannedQuery.query, count, availableSources, configService, domainFilter, recency);
      if (result.success) {
        deduplicateResults(result);
        rankSearchResultData(result);
        successfulSearches.push({ plannedQuery, result });
      } else {
        failedSearches.push(`${plannedQuery.query}: ${result.error || 'Search failed'}`);
      }
    }

    let searchResult = successfulSearches.length === 1
      ? successfulSearches[0].result
      : successfulSearches.length > 1
        ? mergePlannedSearchResults(query, queryPlan, successfulSearches)
        : {
            success: false,
            error: failedSearches.join('\n') || 'WebSearch failed',
          } satisfies ToolExecutionResult;

    if (autoExtract && searchResult.success) {
      const extractedContent = ctx.modelCallback
        ? await autoExtractFromResults(searchResult, query, extractCount, ctx.modelCallback)
        : await autoExtractFallback(searchResult, extractCount);
      if (extractedContent) {
        searchResult = {
          ...searchResult,
          output: `${searchResult.output || ''}\n\n${extractedContent}`,
        };
      }
    }

    if (outputFormat === 'table' && searchResult.success) {
      searchResult = { ...searchResult, output: formatAsTable(searchResult) };
    }

    await translateOutputIfNeeded(searchResult, query, language, ctx.modelCallback, ctx.logger);

    onProgress?.({ stage: 'completing', percent: 100 });

    if (!searchResult.success) {
      const recencyMeta = buildRecencyMeta(recency, availableSources.map(s => s.name));
      return {
        ok: false,
        error: `${searchResult.error || 'WebSearch failed'}\n\n${SEARCH_FAILURE_GUIDANCE}`,
        code: 'NETWORK_ERROR',
        meta: { routing: routingMeta, queryPlan, ...recencyMeta },
      };
    }

    let output = searchResult.output || '';
    const saveTo = typeof args.save_to === 'string' ? args.save_to : undefined;
    let savedArtifact;
    if (saveTo) {
      try {
        const savedPath = await saveSearchOutput(saveTo, ctx.workingDir, query, output);
        output += `\n\n✅ Results saved to: ${savedPath}`;
        savedArtifact = await createFileArtifact(savedPath, schema.name, ctx, {
          kind: 'text',
          mimeType: 'text/markdown',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output += `\n\n⚠️ Failed to save: ${message}`;
        ctx.logger.warn('Failed to save WebSearch results', { saveTo, error: message });
      }
    }

    const resultData = getResultData(searchResult);
    const recencyMeta = buildRecencyMeta(recency, resultData.sources);
    ctx.logger.debug('WebSearch done', {
      resultCount: resultData.results.length,
      sources: resultData.sources,
      durationMs: resultData.duration,
    });

    return {
      ok: true,
      output,
      meta: {
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'search',
          sessionId: ctx.sessionId,
          name: `Search: ${query.slice(0, 80)}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            query,
            mode,
            autoExtract,
            resultCount: resultData.results.length,
            sources: resultData.sources,
            routingReason: routing.reason,
            queryPlan,
            ...recencyMeta,
          },
        }),
        savedArtifact,
        query,
        mode,
        autoExtract,
        extractCount,
        recency,
        ...recencyMeta,
        outputFormat,
        language,
        routing: routingMeta,
        queryPlan,
        resultCount: resultData.results.length,
        results: resultData.results,
        sources: resultData.sources,
        durationMs: resultData.duration,
        domainFilter,
      },
    };
  }
}

export const webSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WebSearchHandler();
  },
};
