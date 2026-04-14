// ============================================================================
// Search Orchestrator
// Parallel/serial search execution and result merging
// ============================================================================

import type { ToolExecutionResult } from '../../types';
import type { getConfigService } from '../../../services/core/configService';
import type { SearchResult, SearchSourceResult, SearchSource, DomainFilter } from './searchTypes';
import {
  getCircuitBreakerRemaining,
  tripCircuitBreaker,
  normalizeTitleForDedup,
} from './searchUtils';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('WebSearch');

// ============================================================================
// Parallel Search
// ============================================================================

export async function parallelSearch(
  query: string,
  count: number,
  sources: SearchSource[],
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // Filter out circuit-broken sources before searching
  const activeSources: SearchSource[] = [];
  const skippedSources: string[] = [];
  for (const source of sources) {
    const remaining = getCircuitBreakerRemaining(source.name);
    if (remaining > 0) {
      logger.info('Circuit breaker active, skipping source', {
        source: source.name,
        cooldownRemaining: `${Math.ceil(remaining / 1000)}s`,
      });
      skippedSources.push(`${source.name}: circuit breaker (${Math.ceil(remaining / 1000)}s remaining)`);
    } else {
      activeSources.push(source);
    }
  }

  if (activeSources.length === 0) {
    return {
      success: false,
      error: `All search sources are circuit-broken:\n${skippedSources.join('\n')}`,
    };
  }

  // 并行调用所有数据源（使用 allSettled 实现错误隔离）
  const searchPromises = activeSources.map(source =>
    source.search(query, count, configService, domainFilter, recency)
      .catch(error => ({
        source: source.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } as SearchSourceResult))
  );

  const results = await Promise.allSettled(searchPromises);

  // 收集成功的结果
  const successResults: SearchSourceResult[] = [];
  const failedSources: string[] = [...skippedSources];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceName = activeSources[i].name;

    if (result.status === 'fulfilled') {
      if (result.value.success) {
        successResults.push(result.value);
      } else {
        // Check for 429 and trip circuit breaker
        if (result.value.error?.includes('429')) {
          tripCircuitBreaker(sourceName);
        }
        failedSources.push(`${sourceName}: ${result.value.error}`);
        logger.warn(`Search source ${sourceName} failed:`, result.value.error);
      }
    } else {
      const reason = String(result.reason);
      if (reason.includes('429')) {
        tripCircuitBreaker(sourceName);
      }
      failedSources.push(`${sourceName}: ${result.reason}`);
      logger.warn(`Search source ${sourceName} rejected:`, result.reason);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Parallel search completed in ${duration}ms:`, {
    success: successResults.length,
    failed: failedSources.length,
  });

  if (successResults.length === 0) {
    return {
      success: false,
      error: `All search sources failed:\n${failedSources.join('\n')}`,
    };
  }

  // 合并结果
  return mergeSearchResults(query, successResults, failedSources, duration);
}

// ============================================================================
// Serial Search (Fallback)
// ============================================================================

export async function serialSearch(
  query: string,
  count: number,
  sources: SearchSource[],
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  for (const source of sources) {
    // Check circuit breaker
    const remaining = getCircuitBreakerRemaining(source.name);
    if (remaining > 0) {
      logger.info('Circuit breaker active, skipping source', {
        source: source.name,
        cooldownRemaining: `${Math.ceil(remaining / 1000)}s`,
      });
      errors.push(`${source.name}: circuit breaker (${Math.ceil(remaining / 1000)}s remaining)`);
      continue;
    }

    try {
      const result = await source.search(query, count, configService, domainFilter, recency);
      if (result.success) {
        const duration = Date.now() - startTime;
        return formatSingleSourceResult(query, result, duration);
      }
      // Check for 429 and trip circuit breaker
      if (result.error?.includes('429')) {
        tripCircuitBreaker(source.name);
      }
      errors.push(`${source.name}: ${result.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('429')) {
        tripCircuitBreaker(source.name);
      }
      errors.push(`${source.name}: ${message}`);
      logger.warn(`Search source ${source.name} failed:`, message);
    }
  }

  return {
    success: false,
    error: `All search sources failed:\n${errors.join('\n')}`,
  };
}

// ============================================================================
// Result Formatting
// ============================================================================

export function mergeSearchResults(
  query: string,
  results: SearchSourceResult[],
  failedSources: string[],
  duration: number
): ToolExecutionResult {
  const outputParts: string[] = [];
  const allResults: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();

  outputParts.push(`# Search results for: "${query}"`);
  outputParts.push(`Sources: ${results.map(r => r.source).join(', ')}`);
  outputParts.push('');

  // 处理每个数据源的结果
  for (const result of results) {
    // Perplexity 返回 AI 生成的答案
    if (result.answer) {
      outputParts.push(`## AI Summary (${result.source})`);
      outputParts.push(result.answer);
      if (result.citations && result.citations.length > 0) {
        outputParts.push('\nCitations:');
        result.citations.forEach((c, i) => outputParts.push(`${i + 1}. ${c}`));
      }
      outputParts.push('');
    }

    // 传统搜索结果
    if (result.results && result.results.length > 0) {
      outputParts.push(`## Results from ${result.source}`);
      for (const item of result.results) {
        // 去重（基于 URL + 标题前缀规范化）
        const normalizedTitle = normalizeTitleForDedup(item.title || '');
        if (!seenUrls.has(item.url) && !seenTitles.has(normalizedTitle)) {
          seenUrls.add(item.url);
          if (normalizedTitle) seenTitles.add(normalizedTitle);
          allResults.push({ ...item, source: result.source });
          const snippet = item.snippet || item.description || '';
          outputParts.push(`- **${item.title}**${item.age ? ` (${item.age})` : ''}`);
          outputParts.push(`  ${item.url}`);
          if (snippet) outputParts.push(`  ${snippet}`);
        }
      }
      outputParts.push('');
    }
  }

  // Log dedup statistics
  const totalResults = results.reduce((sum, r) => sum + (r.results?.length || 0), 0);
  const dedupedResults = allResults.length;
  logger.info('Search results dedup', { before: totalResults, after: dedupedResults, removed: totalResults - dedupedResults });

  // 如果有失败的数据源，添加提示
  if (failedSources.length > 0) {
    outputParts.push(`_Note: Some sources failed: ${failedSources.join('; ')}_`);
  }

  return {
    success: true,
    output: outputParts.join('\n'),
    result: {
      results: allResults,
      sources: results.map(r => r.source),
      duration,
    },
  };
}

function formatSingleSourceResult(
  query: string,
  result: SearchSourceResult,
  duration: number
): ToolExecutionResult {
  const outputParts: string[] = [];

  outputParts.push(`Search results for: "${query}" (via ${result.source})`);
  outputParts.push('');

  if (result.answer) {
    outputParts.push(result.answer);
    if (result.citations && result.citations.length > 0) {
      outputParts.push('\nSources:');
      result.citations.forEach((c, i) => outputParts.push(`${i + 1}. ${c}`));
    }
  } else if (result.results && result.results.length > 0) {
    result.results.forEach((item, index) => {
      const snippet = item.snippet || item.description || '';
      outputParts.push(`${index + 1}. ${item.title}${item.age ? ` (${item.age})` : ''}`);
      outputParts.push(`   ${item.url}`);
      if (snippet) outputParts.push(`   ${snippet}`);
      outputParts.push('');
    });
  } else {
    outputParts.push('No results found.');
  }

  return {
    success: true,
    output: outputParts.join('\n'),
    result: {
      results: result.results || [],
      source: result.source,
      duration,
    },
  };
}
