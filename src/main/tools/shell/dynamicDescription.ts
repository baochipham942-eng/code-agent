// ============================================================================
// Dynamic Description - Generate short bash command descriptions using LLM
// ============================================================================

import { ModelRouter } from '../../model/modelRouter';
import { createLogger } from '../../services/infra/logger';
import type { ModelProvider } from '../../../shared/types';

const logger = createLogger('DynamicDescription');

// LRU 缓存：命令前缀 → 描述
const descriptionCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

let router: ModelRouter | null = null;

/**
 * 为 bash 命令生成 5-10 词的简短描述
 * 使用 GLM-4-Flash（免费）生成，与命令执行并行不增加延迟
 */
export async function generateBashDescription(command: string): Promise<string | null> {
  const cacheKey = command.slice(0, 80);
  if (descriptionCache.has(cacheKey)) {
    return descriptionCache.get(cacheKey)!;
  }

  try {
    if (!router) router = new ModelRouter();
    const response = await router.chat({
      provider: 'zhipu' as ModelProvider,
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: `Describe this command in 5-10 words: ${command.slice(0, 200)}` }],
      maxTokens: 30,
    });

    const description = response.content?.trim();
    if (description) {
      // LRU 淘汰
      if (descriptionCache.size >= MAX_CACHE_SIZE) {
        const firstKey = descriptionCache.keys().next().value;
        if (firstKey) descriptionCache.delete(firstKey);
      }
      descriptionCache.set(cacheKey, description);
      return description;
    }
  } catch (error) {
    logger.debug('[DynamicDescription] Failed to generate description:', error);
  }
  return null;
}
