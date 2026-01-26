// ============================================================================
// Prompt Service - 云端 System Prompt 管理
// ============================================================================
// 优先从云端拉取 prompts，本地缓存 + 降级到内置 prompts

import type { GenerationId } from '../../../shared/types';
import { SYSTEM_PROMPTS } from '../../generation/prompts/builder';
import { createLogger } from '../infra/logger';
import { CACHE, CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';

const logger = createLogger('PromptService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface CloudPromptsResponse {
  version: string;
  prompts: Record<string, string>;
}

interface CachedPrompts {
  version: string;
  prompts: Record<string, string>;
  fetchedAt: number;
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

let cachedPrompts: CachedPrompts | null = null;
let fetchPromise: Promise<void> | null = null;

// ----------------------------------------------------------------------------
// Core Functions
// ----------------------------------------------------------------------------

/**
 * 从云端拉取 prompts
 */
async function fetchCloudPrompts(): Promise<CloudPromptsResponse | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLOUD.FETCH_TIMEOUT);

    const response = await fetch(`${CLOUD_ENDPOINTS.prompts}?gen=all`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn('Cloud API error', { status: response.status });
      return null;
    }

    const data = await response.json();
    logger.info('Fetched cloud prompts', { version: data.version });
    return data;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warn('Cloud fetch timeout');
    } else {
      logger.warn('Cloud fetch failed', { error });
    }
    return null;
  }
}

/**
 * 初始化 prompt 服务（后台异步拉取）
 */
export async function initPromptService(): Promise<void> {
  // 避免重复拉取
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    const cloudData = await fetchCloudPrompts();
    if (cloudData) {
      cachedPrompts = {
        version: cloudData.version,
        prompts: cloudData.prompts,
        fetchedAt: Date.now(),
      };
      logger.info('Cached cloud prompts');
    } else {
      logger.info('Using built-in prompts');
    }
  })();

  return fetchPromise;
}

/**
 * 获取指定代际的 system prompt
 * 优先返回云端版本，降级到本地内置版本
 */
export function getSystemPrompt(generationId: GenerationId): string {
  // 检查缓存是否有效
  if (cachedPrompts) {
    const isExpired = Date.now() - cachedPrompts.fetchedAt > CACHE.PROMPT_TTL;

    if (!isExpired && cachedPrompts.prompts[generationId]) {
      return cachedPrompts.prompts[generationId];
    }

    // 缓存过期，后台刷新（不阻塞）
    if (isExpired) {
      logger.info('Cache expired, refreshing in background');
      fetchPromise = null;
      initPromptService().catch(() => {});
    }

    // 即使过期也先返回缓存的
    if (cachedPrompts.prompts[generationId]) {
      return cachedPrompts.prompts[generationId];
    }
  }

  // 降级到内置 prompts
  return SYSTEM_PROMPTS[generationId];
}

/**
 * 强制刷新 prompts
 */
export async function refreshPrompts(): Promise<boolean> {
  fetchPromise = null;
  cachedPrompts = null;
  await initPromptService();
  return cachedPrompts !== null;
}

/**
 * 获取当前 prompts 来源信息
 */
export function getPromptsInfo(): {
  source: 'cloud' | 'builtin';
  version: string | null;
  fetchedAt: number | null;
} {
  if (cachedPrompts) {
    return {
      source: 'cloud',
      version: cachedPrompts.version,
      fetchedAt: cachedPrompts.fetchedAt,
    };
  }
  return {
    source: 'builtin',
    version: null,
    fetchedAt: null,
  };
}
