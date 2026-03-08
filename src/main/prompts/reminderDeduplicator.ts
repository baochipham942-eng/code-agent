// ============================================================================
// Reminder Deduplicator - 提醒去重逻辑
// ============================================================================
// 避免语义重复的提醒同时出现
// 使用 exclusiveGroup 和内容相似度进行去重
// ============================================================================

import type { ReminderDefinition, ReminderContext } from './reminderRegistry';

/**
 * 去重后的提醒结果
 */
export interface DeduplicatedReminder {
  reminder: ReminderDefinition;
  score: number;
  selected: boolean;
  reason?: string;
}

/**
 * 对提醒进行去重
 *
 * 去重规则：
 * 1. 同一 exclusiveGroup 只保留分数最高的一个
 * 2. 语义相似的提醒只保留一个
 * 3. 优先级高的提醒优先保留
 */
export function deduplicateReminders(
  reminders: Array<{ reminder: ReminderDefinition; score: number }>,
  context: ReminderContext
): DeduplicatedReminder[] {
  const result: DeduplicatedReminder[] = [];
  const selectedGroups = new Set<string>();
  const selectedCategories = new Map<string, number>(); // category -> count

  // 按分数和优先级排序
  const sorted = [...reminders].sort((a, b) => {
    // 优先级高的排前面
    if (a.reminder.priority !== b.reminder.priority) {
      return a.reminder.priority - b.reminder.priority;
    }
    // 分数高的排前面
    return b.score - a.score;
  });

  for (const item of sorted) {
    const { reminder, score } = item;
    let selected = true;
    let reason: string | undefined;

    // 检查 exclusiveGroup
    if (reminder.exclusiveGroup) {
      if (selectedGroups.has(reminder.exclusiveGroup)) {
        selected = false;
        reason = `已有同组提醒: ${reminder.exclusiveGroup}`;
      } else {
        selectedGroups.add(reminder.exclusiveGroup);
      }
    }

    // 检查同类别数量限制（每个类别最多 2 个）
    if (selected) {
      const categoryCount = selectedCategories.get(reminder.category) || 0;
      if (categoryCount >= 2) {
        selected = false;
        reason = `同类别提醒已达上限: ${reminder.category}`;
      } else {
        selectedCategories.set(reminder.category, categoryCount + 1);
      }
    }

    // 检查语义相似度
    if (selected) {
      const similarReminder = findSimilarReminder(reminder, result);
      if (similarReminder) {
        selected = false;
        reason = `与已选提醒语义相似: ${similarReminder.reminder.id}`;
      }
    }

    result.push({ reminder, score, selected, reason });
  }

  return result;
}

/**
 * 查找语义相似的提醒
 */
function findSimilarReminder(
  target: ReminderDefinition,
  selected: DeduplicatedReminder[]
): DeduplicatedReminder | null {
  for (const item of selected) {
    if (!item.selected) continue;

    // 简单的关键词相似度检测
    const similarity = calculateSimilarity(target.content, item.reminder.content);
    if (similarity > 0.6) {
      return item;
    }
  }
  return null;
}

/**
 * 计算两段文本的相似度（基于关键词重叠）
 */
function calculateSimilarity(text1: string, text2: string): number {
  const keywords1 = extractKeywords(text1);
  const keywords2 = extractKeywords(text2);

  if (keywords1.size === 0 || keywords2.size === 0) {
    return 0;
  }

  const intersection = new Set([...keywords1].filter((k) => keywords2.has(k)));
  const union = new Set([...keywords1, ...keywords2]);

  return intersection.size / union.size;
}

/**
 * 提取文本关键词
 */
function extractKeywords(text: string): Set<string> {
  // 移除 HTML 标签和特殊字符
  const cleaned = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
    .toLowerCase();

  // 分词
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2);

  // 过滤停用词
  const stopWords = new Set([
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
    '的', '了', '是', '在', '有', '和', '与', '或', '但',
    'system', 'reminder', 'system-reminder',
  ]);

  return new Set(words.filter((w) => !stopWords.has(w)));
}

/**
 * 合并选中的提醒内容
 */
export function mergeSelectedReminders(
  deduplicated: DeduplicatedReminder[]
): string[] {
  return deduplicated
    .filter((d) => d.selected)
    .map((d) => d.reminder.content);
}

/**
 * 获取去重统计信息
 */
export function getDeduplicationStats(
  deduplicated: DeduplicatedReminder[]
): {
  total: number;
  selected: number;
  filtered: number;
  byReason: Record<string, number>;
} {
  const byReason: Record<string, number> = {};

  for (const d of deduplicated) {
    if (!d.selected && d.reason) {
      const reasonKey = d.reason.split(':')[0];
      byReason[reasonKey] = (byReason[reasonKey] || 0) + 1;
    }
  }

  return {
    total: deduplicated.length,
    selected: deduplicated.filter((d) => d.selected).length,
    filtered: deduplicated.filter((d) => !d.selected).length,
    byReason,
  };
}
