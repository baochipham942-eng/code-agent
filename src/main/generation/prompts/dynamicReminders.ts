// ============================================================================
// Dynamic Reminders - 动态提醒选择核心逻辑
// ============================================================================
// 借鉴 Claude Code 的 40 个动态系统提醒设计
// 实现上下文感知、优先级排序、去重的动态提醒系统
// ============================================================================

import {
  REMINDER_DEFINITIONS,
  type ReminderDefinition,
  type ReminderContext,
  type ReminderPriority,
} from './reminderRegistry';
import {
  deduplicateReminders,
  mergeSelectedReminders,
  getDeduplicationStats,
} from './reminderDeduplicator';
import { applyContextRules, getActiveRules } from './contextAwareReminders';
import {
  selectRelevantExamples,
  formatExamplesForPrompt,
  type FewShotExample,
} from './fewShotExamples';
import {
  TokenBudgetManager,
  selectRemindersWithinBudget,
  getTokenBudgetManager,
  DEFAULT_BUDGET_CONFIG,
} from '../../context/reminderBudget';
import { detectTaskFeatures, type TaskFeatures } from './systemReminders';

/**
 * 动态提醒选择结果
 */
export interface ReminderSelectionResult {
  reminders: string[];
  selectedCount: number;
  totalCandidates: number;
  tokensUsed: number;
  tokenBudget: number;
  features: TaskFeatures;
  examples: FewShotExample[];
  stats: {
    byPriority: Record<ReminderPriority, number>;
    byCategory: Record<string, number>;
    deduplication: {
      total: number;
      selected: number;
      filtered: number;
    };
    contextRulesApplied: string[];
  };
}

/**
 * 动态提醒选择选项
 */
export interface ReminderSelectionOptions {
  maxTokens?: number;
  includeFewShot?: boolean;
  maxFewShotExamples?: number;
  fewShotTokenBudget?: number;
}

/**
 * 选择动态提醒
 *
 * 流程：
 * 1. 检测任务特征
 * 2. 计算每个提醒的匹配分数
 * 3. 应用上下文规则调整分数
 * 4. 去重
 * 5. 在预算内选择
 * 6. 可选添加 few-shot 示例
 */
export function selectReminders(
  context: ReminderContext,
  options: ReminderSelectionOptions = {}
): ReminderSelectionResult {
  const {
    maxTokens = DEFAULT_BUDGET_CONFIG.maxReminderTokens,
    includeFewShot = true,
    maxFewShotExamples = 2,
    fewShotTokenBudget = 400,
  } = options;

  // 1. 计算每个提醒的匹配分数
  const scored = REMINDER_DEFINITIONS.map((reminder) => ({
    reminder,
    score: reminder.shouldInclude(context),
  })).filter((s) => s.score > 0);

  // 2. 应用上下文规则
  const withRules = applyContextRules(scored, context);
  const activeRules = getActiveRules(context);

  // 3. 过滤被抑制的提醒
  const notSuppressed = withRules
    .filter((r) => !r.suppressed && r.score > 0)
    .map((r) => ({ reminder: r.reminder, score: r.score }));

  // 4. 去重
  const deduplicated = deduplicateReminders(notSuppressed, context);
  const deduplicationStats = getDeduplicationStats(deduplicated);

  // 5. 在预算内选择
  const selectedCandidates = deduplicated
    .filter((d) => d.selected)
    .map((d) => ({ reminder: d.reminder, score: d.score }));

  const budgetManager = new TokenBudgetManager({ maxReminderTokens: maxTokens });
  const selectedReminders = selectRemindersWithinBudget(selectedCandidates, budgetManager);

  // 6. 统计信息
  const byPriority: Record<ReminderPriority, number> = { 1: 0, 2: 0, 3: 0 };
  const byCategory: Record<string, number> = {};

  for (const reminder of selectedReminders) {
    byPriority[reminder.priority]++;
    byCategory[reminder.category] = (byCategory[reminder.category] || 0) + 1;
  }

  // 7. 可选：添加 few-shot 示例
  let examples: FewShotExample[] = [];
  if (includeFewShot && context.tokenBudget > fewShotTokenBudget) {
    // 根据任务特征选择相关示例
    const taskDescription = getTaskDescriptionFromFeatures(context.taskFeatures);
    examples = selectRelevantExamples(taskDescription, maxFewShotExamples, fewShotTokenBudget);
  }

  // 8. 组合提醒内容
  const reminderContents = selectedReminders.map((r) => r.content);

  // 如果有 few-shot 示例，添加到末尾
  if (examples.length > 0) {
    const exampleContent = formatExamplesForPrompt(examples);
    reminderContents.push(exampleContent);
  }

  const budgetStats = budgetManager.getStats();

  return {
    reminders: reminderContents,
    selectedCount: selectedReminders.length,
    totalCandidates: scored.length,
    tokensUsed: budgetStats.used,
    tokenBudget: maxTokens,
    features: context.taskFeatures,
    examples,
    stats: {
      byPriority,
      byCategory,
      deduplication: {
        total: deduplicationStats.total,
        selected: deduplicationStats.selected,
        filtered: deduplicationStats.filtered,
      },
      contextRulesApplied: activeRules.map((r) => r.id),
    },
  };
}

/**
 * 从任务特征生成描述（用于 few-shot 示例选择）
 */
function getTaskDescriptionFromFeatures(features: TaskFeatures): string {
  const parts: string[] = [];

  if (features.isAuditTask) parts.push('审计 audit security');
  if (features.isReviewTask) parts.push('审查 review');
  if (features.isPlanningTask) parts.push('规划 plan design');
  if (features.isComplexTask) parts.push('复杂 complex');
  if (features.isMultiDimension) parts.push('并行 parallel');
  if (features.dimensions.length > 0) {
    parts.push(features.dimensions.join(' '));
  }

  return parts.join(' ');
}

/**
 * 创建提醒上下文
 */
export function createReminderContext(
  taskPrompt: string,
  options: {
    toolsUsedInTurn?: string[];
    iterationCount?: number;
    tokenBudget?: number;
    currentMode?: string;
    hasError?: boolean;
    lastToolResult?: string;
  } = {}
): ReminderContext {
  const features = detectTaskFeatures(taskPrompt);

  return {
    taskFeatures: features,
    toolsUsedInTurn: options.toolsUsedInTurn || [],
    iterationCount: options.iterationCount || 0,
    tokenBudget: options.tokenBudget || 4000,
    currentMode: options.currentMode || 'normal',
    hasError: options.hasError || false,
    lastToolResult: options.lastToolResult,
  };
}

/**
 * 快捷方法：根据任务 prompt 获取动态提醒
 */
export function getRemindersForTask(
  taskPrompt: string,
  options: {
    toolsUsedInTurn?: string[];
    iterationCount?: number;
    currentMode?: string;
    hasError?: boolean;
    maxTokens?: number;
    includeFewShot?: boolean;
  } = {}
): string[] {
  const context = createReminderContext(taskPrompt, options);
  const result = selectReminders(context, {
    maxTokens: options.maxTokens,
    includeFewShot: options.includeFewShot,
  });
  return result.reminders;
}

/**
 * 将提醒附加到用户消息
 */
export function appendRemindersToMessage(
  userMessage: string,
  reminders: string[]
): string {
  if (reminders.length === 0) {
    return userMessage;
  }

  return userMessage + '\n\n' + reminders.join('\n');
}

/**
 * 获取提醒系统统计信息
 */
export function getReminderSystemStats(): {
  totalDefinitions: number;
  byPriority: Record<ReminderPriority, number>;
  byCategory: Record<string, number>;
  totalTokens: number;
} {
  const byPriority: Record<ReminderPriority, number> = { 1: 0, 2: 0, 3: 0 };
  const byCategory: Record<string, number> = {};
  let totalTokens = 0;

  for (const reminder of REMINDER_DEFINITIONS) {
    byPriority[reminder.priority]++;
    byCategory[reminder.category] = (byCategory[reminder.category] || 0) + 1;
    totalTokens += reminder.tokens;
  }

  return {
    totalDefinitions: REMINDER_DEFINITIONS.length,
    byPriority,
    byCategory,
    totalTokens,
  };
}
