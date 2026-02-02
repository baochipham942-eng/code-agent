// ============================================================================
// Context-Aware Reminders - 上下文感知规则
// ============================================================================
// 根据对话上下文动态调整提醒
// 避免重复、冗余的提醒
// ============================================================================

import type { ReminderContext, ReminderDefinition } from './reminderRegistry';

/**
 * 上下文规则类型
 */
export type ContextRuleType =
  | 'suppress'     // 抑制提醒
  | 'boost'        // 增强提醒权重
  | 'replace'      // 替换为其他提醒
  | 'conditional'; // 条件触发

/**
 * 上下文规则定义
 */
export interface ContextRule {
  id: string;
  type: ContextRuleType;
  description: string;
  condition: (context: ReminderContext) => boolean;
  effect: (reminderId: string, score: number, context: ReminderContext) => {
    newScore: number;
    suppress?: boolean;
    replaceWith?: string;
  };
}

// ----------------------------------------------------------------------------
// 上下文规则定义
// ----------------------------------------------------------------------------

export const CONTEXT_RULES: ContextRule[] = [
  // ----------------------------------------------------------------------------
  // 抑制规则
  // ----------------------------------------------------------------------------
  {
    id: 'suppress_after_successful_delegation',
    type: 'suppress',
    description: '成功委派后不再提醒委派',
    condition: (ctx) =>
      ctx.toolsUsedInTurn.includes('task') && !ctx.hasError,
    effect: (reminderId, score) => {
      if (reminderId === 'MUST_DELEGATE' || reminderId === 'TASK_NOT_DIRECT') {
        return { newScore: 0, suppress: true };
      }
      return { newScore: score };
    },
  },
  {
    id: 'suppress_parallel_after_dispatch',
    type: 'suppress',
    description: '已并行派发后不再提醒并行',
    condition: (ctx) =>
      ctx.toolsUsedInTurn.filter((t) => t === 'task').length >= 2,
    effect: (reminderId, score) => {
      if (reminderId === 'PARALLEL_DISPATCH') {
        return { newScore: 0, suppress: true };
      }
      return { newScore: score };
    },
  },
  {
    id: 'suppress_mode_reminders_in_normal',
    type: 'suppress',
    description: '正常模式下抑制模式切换提醒',
    condition: (ctx) => ctx.currentMode === 'normal' && ctx.iterationCount < 3,
    effect: (reminderId, score) => {
      if (reminderId.endsWith('_MODE')) {
        return { newScore: score * 0.3 };
      }
      return { newScore: score };
    },
  },

  // ----------------------------------------------------------------------------
  // 增强规则
  // ----------------------------------------------------------------------------
  {
    id: 'boost_error_recovery',
    type: 'boost',
    description: '错误时增强恢复提醒',
    condition: (ctx) => ctx.hasError,
    effect: (reminderId, score) => {
      if (reminderId === 'ERROR_RECOVERY') {
        return { newScore: Math.min(score * 2, 1) };
      }
      return { newScore: score };
    },
  },
  {
    id: 'boost_verification_after_edit',
    type: 'boost',
    description: '编辑后增强验证提醒',
    condition: (ctx) =>
      ctx.toolsUsedInTurn.includes('edit_file') ||
      ctx.toolsUsedInTurn.includes('write_file'),
    effect: (reminderId, score) => {
      if (reminderId === 'VERIFY_BEFORE_COMMIT') {
        return { newScore: Math.min(score * 1.5, 1) };
      }
      return { newScore: score };
    },
  },
  {
    id: 'boost_security_warnings',
    type: 'boost',
    description: '检测到敏感操作时增强安全警告',
    condition: (ctx) => {
      const sensitiveKeywords = ['delete', 'remove', 'drop', 'force', 'hard'];
      const lastResult = ctx.lastToolResult?.toLowerCase() || '';
      return sensitiveKeywords.some((k) => lastResult.includes(k));
    },
    effect: (reminderId, score) => {
      if (
        reminderId === 'SECURITY_SENSITIVE_FILE' ||
        reminderId === 'DESTRUCTIVE_OPERATION_WARNING'
      ) {
        return { newScore: Math.min(score * 2, 1) };
      }
      return { newScore: score };
    },
  },

  // ----------------------------------------------------------------------------
  // 条件触发规则
  // ----------------------------------------------------------------------------
  {
    id: 'conditional_batch_reminder',
    type: 'conditional',
    description: '多次单一工具调用后提醒批量操作',
    condition: (ctx) =>
      ctx.iterationCount > 3 &&
      ctx.toolsUsedInTurn.length === 1 &&
      !ctx.toolsUsedInTurn.includes('task'),
    effect: (reminderId, score) => {
      if (reminderId === 'BATCH_OPERATIONS') {
        return { newScore: Math.min(score + 0.5, 1) };
      }
      return { newScore: score };
    },
  },
  {
    id: 'conditional_long_conversation',
    type: 'conditional',
    description: '长对话时触发总结提醒',
    condition: (ctx) => ctx.iterationCount > 10,
    effect: (reminderId, score) => {
      if (reminderId === 'LONG_CONVERSATION') {
        return { newScore: Math.min(score + 0.3, 1) };
      }
      return { newScore: score };
    },
  },
  {
    id: 'conditional_iteration_warning',
    type: 'conditional',
    description: '迭代次数过多时警告',
    condition: (ctx) => ctx.iterationCount > 15,
    effect: (reminderId, score) => {
      if (reminderId === 'ITERATION_LIMIT_WARNING') {
        return { newScore: 1 }; // 强制显示
      }
      return { newScore: score };
    },
  },

  // ----------------------------------------------------------------------------
  // 替换规则
  // ----------------------------------------------------------------------------
  {
    id: 'replace_delegate_with_explore',
    type: 'replace',
    description: '简单探索任务时替换委派提醒',
    condition: (ctx) =>
      ctx.taskFeatures.isComplexTask === false &&
      ctx.taskFeatures.dimensions.length === 0,
    effect: (reminderId, score, ctx) => {
      if (reminderId === 'MUST_DELEGATE') {
        // 简单任务不需要强制委派
        return { newScore: score * 0.3 };
      }
      return { newScore: score };
    },
  },
];

/**
 * 应用所有上下文规则
 */
export function applyContextRules(
  reminders: Array<{ reminder: ReminderDefinition; score: number }>,
  context: ReminderContext
): Array<{ reminder: ReminderDefinition; score: number; suppressed: boolean }> {
  return reminders.map(({ reminder, score }) => {
    let currentScore = score;
    let suppressed = false;

    for (const rule of CONTEXT_RULES) {
      if (!rule.condition(context)) continue;

      const effect = rule.effect(reminder.id, currentScore, context);
      currentScore = effect.newScore;

      if (effect.suppress) {
        suppressed = true;
      }
    }

    return { reminder, score: currentScore, suppressed };
  });
}

/**
 * 获取活跃的上下文规则
 */
export function getActiveRules(context: ReminderContext): ContextRule[] {
  return CONTEXT_RULES.filter((rule) => rule.condition(context));
}

/**
 * 获取规则应用统计
 */
export function getRuleStats(
  context: ReminderContext
): { ruleId: string; active: boolean; type: ContextRuleType }[] {
  return CONTEXT_RULES.map((rule) => ({
    ruleId: rule.id,
    active: rule.condition(context),
    type: rule.type,
  }));
}
