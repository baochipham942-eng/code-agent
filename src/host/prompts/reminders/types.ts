// ============================================================================
// Reminder Types - 提醒类型定义
// ============================================================================

import type { TaskFeatures } from '../systemReminders';
export { estimateTokens } from '../../context/tokenEstimator';

/**
 * 提醒优先级
 * 1 = 关键（必须包含）
 * 2 = 重要（空间允许时包含）
 * 3 = 辅助（可选，用于增强）
 */
export type ReminderPriority = 1 | 2 | 3;

/**
 * 提醒上下文
 */
export interface ReminderContext {
  taskFeatures: TaskFeatures;
  toolsUsedInTurn: string[];
  iterationCount: number;
  tokenBudget: number;
  currentMode: string;
  hasError: boolean;
  lastToolResult?: string;
  /**
   * 本轮激活的 skill 名（无 skill 时缺省）。
   * 内容生成类提醒靠它避开 authoring skill 流程——那些流程自带访谈规则，
   * 被「先出稿不要先问」压住会退化成纯文本追问。
   */
  activeSkillName?: string;
}

/**
 * 提醒定义
 */
export interface ReminderDefinition {
  id: string;
  priority: ReminderPriority;
  content: string;
  tokens: number;
  shouldInclude: (context: ReminderContext) => number; // 返回 0-1 的匹配分数
  exclusiveGroup?: string; // 用于去重，同组只选一个
  category: 'mode' | 'tool' | 'safety' | 'efficiency' | 'quality';
}
