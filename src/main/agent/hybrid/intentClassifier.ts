// ============================================================================
// Intent Classifier - LLM-based intent classification (hybrid fast/slow path)
// ============================================================================
//
// 当关键词匹配（快速路径）未命中时，使用轻量 LLM 调用判断任务意图。
// 使用免费模型 (GLM-4-Flash) ，零成本，约 1s 延迟。
//
// 参考：DeerFlow 的 LLM + tool-use 意图分类方案（简化版）
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { ModelRouter } from '../../model/modelRouter';

const logger = createLogger('IntentClassifier');

// Use free model for classification — zero cost, ~1s latency
const CLASSIFIER_PROVIDER = 'zhipu' as const;
const CLASSIFIER_MODEL = 'glm-4-flash';

/** Classification timeout to prevent blocking main flow (8s for free model) */
const CLASSIFY_TIMEOUT_MS = 8000;

export type TaskIntent = 'research' | 'code' | 'search' | 'data' | 'general';

const VALID_INTENTS: readonly TaskIntent[] = ['research', 'code', 'search', 'data', 'general'];

const CLASSIFY_PROMPT = `你是一个任务意图分类器。根据用户消息判断任务类型，只返回一个分类标签。

分类规则：
- **research**: 需要多角度深入调查、分析报告、市场调研、趋势分析、对比研究等（例：调查市场情况、分析行业趋势、帮我研究一下、帮我调查一下）
- **data**: 数据处理、Excel/CSV操作、数据分析、SQL查询
- **code**: 编程、代码修改、bug修复、重构、实现功能
- **search**: 简单信息查找、查一个具体事实（例：查一下某个API的用法）
- **general**: 闲聊、问答、其他

只返回分类标签（research/code/search/data/general），不要返回任何其他内容。`;


/**
 * Quick keyword-based intent check (0ms, 100% reliable).
 * Returns a TaskIntent if keywords match, or null to fall through to LLM.
 */
function quickIntentCheck(message: string): TaskIntent | null {
  const researchKeywords = /深入调研|深度搜索|深度调研|全面分析|深入分析|深入搜索|研究报告|详细调研|comprehensive\s*research|in-depth|deep\s*research|thorough\s*research/i;
  if (researchKeywords.test(message)) return 'research';
  return null; // No quick match, need LLM
}

/**
 * Classify user message intent using a lightweight LLM call.
 *
 * - Uses GLM-4-Flash (free, fast) for classification
 * - Returns 'general' on any failure (safe fallback)
 * - Enforced 8s timeout to never block the main flow
 */
export async function classifyIntent(
  message: string,
  modelRouter: ModelRouter,
): Promise<TaskIntent> {
  // Step 1: Quick keyword check (0ms, 100% reliable)
  const quickResult = quickIntentCheck(message);
  if (quickResult) {
    logger.info('Intent classified via keywords', {
      intent: quickResult,
      message: message.substring(0, 80),
    });
    return quickResult;
  }

  // Step 2: LLM classification (slower but handles ambiguous cases)
  try {
    const response = await Promise.race([
      modelRouter.chat({
        provider: CLASSIFIER_PROVIDER,
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: message },
        ],
        maxTokens: 10,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Intent classification timed out')), CLASSIFY_TIMEOUT_MS)
      ),
    ]);

    const label = (response?.content || '').trim().toLowerCase() as TaskIntent;

    if (VALID_INTENTS.includes(label)) {
      logger.info('Intent classified via LLM', {
        message: message.substring(0, 50),
        intent: label,
      });
      return label;
    }

    logger.warn('Unexpected classification result, defaulting to general', { result: label });
    return 'general';
  } catch (error) {
    logger.warn('Intent classification failed, defaulting to general', {
      error: String(error),
    });
    return 'general';
  }
}
