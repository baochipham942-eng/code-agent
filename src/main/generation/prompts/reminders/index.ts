// ============================================================================
// Reminder Registry - 汇总导出
// ============================================================================
// 从子模块收集所有提醒定义，保持与原 reminderRegistry.ts 相同的导出接口
// ============================================================================

// 类型重导出
export type { ReminderPriority, ReminderContext, ReminderDefinition } from './types';
export { estimateTokens } from './types';

// 子模块导入
import { MODE_REMINDERS } from './modes';
import { TASK_ROUTING_REMINDERS } from './taskRouting';
import { SECURITY_REMINDERS } from './security';
import { TOOL_USAGE_REMINDERS } from './toolUsage';
import { QUALITY_REMINDERS } from './quality';
import { CONTENT_GENERATION_REMINDERS } from './contentGeneration';

import type { ReminderDefinition, ReminderPriority } from './types';

// ----------------------------------------------------------------------------
// 汇总所有提醒定义（保持与原 REMINDER_DEFINITIONS 完全一致的顺序）
// ----------------------------------------------------------------------------

export const REMINDER_DEFINITIONS: ReminderDefinition[] = [
  ...MODE_REMINDERS,
  ...TASK_ROUTING_REMINDERS,
  ...TOOL_USAGE_REMINDERS,
  ...SECURITY_REMINDERS,
  ...QUALITY_REMINDERS,
  ...CONTENT_GENERATION_REMINDERS,
];

// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------

/**
 * 按优先级获取提醒
 */
export function getRemindersByPriority(priority: ReminderPriority): ReminderDefinition[] {
  return REMINDER_DEFINITIONS.filter((r) => r.priority === priority);
}

/**
 * 按类别获取提醒
 */
export function getRemindersByCategory(
  category: ReminderDefinition['category']
): ReminderDefinition[] {
  return REMINDER_DEFINITIONS.filter((r) => r.category === category);
}

/**
 * 根据 ID 获取提醒
 */
export function getReminderById(id: string): ReminderDefinition | undefined {
  return REMINDER_DEFINITIONS.find((r) => r.id === id);
}

/**
 * 获取所有提醒的总 token 数
 */
export function getTotalReminderTokens(): number {
  return REMINDER_DEFINITIONS.reduce((sum, r) => sum + r.tokens, 0);
}

// 子模块导出（供需要按类型访问的场景使用）
export { MODE_REMINDERS } from './modes';
export { TASK_ROUTING_REMINDERS } from './taskRouting';
export { SECURITY_REMINDERS } from './security';
export { TOOL_USAGE_REMINDERS } from './toolUsage';
export { QUALITY_REMINDERS } from './quality';
export { CONTENT_GENERATION_REMINDERS } from './contentGeneration';
