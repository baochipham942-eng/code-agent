// ============================================================================
// 意图工具预载 — 按启动任务特征把 deferred 工具直接标为已加载，
// 省掉模型用 ToolSearch 发现工具的推理轮次。
// 配合 systemReminders 的场景 reminder（如 SCREEN_CAPTURE）使用。
// ============================================================================

import type { TaskFeatures } from '../../prompts/systemReminders';
import { getToolSearchService } from '../../services/toolSearch';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('IntentToolPreload');

/** 截屏/查看屏幕意图需要的视觉工具（截屏本身走 Bash screencapture，无需预载） */
const SCREEN_CAPTURE_TOOLS = ['image_analyze'];

/**
 * 按任务特征预载工具，返回实际新加载的工具名。
 * 不可加载/未知工具由 ToolSearchService 静默跳过。
 */
export function preloadToolsForIntent(features: TaskFeatures): string[] {
  if (!features.isScreenCaptureTask) return [];
  const preloaded = getToolSearchService().preloadTools(SCREEN_CAPTURE_TOOLS);
  if (preloaded.length > 0) {
    logger.info('[AgentLoop] Screen-capture intent detected, preloaded tools', { preloaded });
  }
  return preloaded;
}
