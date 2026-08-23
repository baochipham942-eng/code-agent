// MemoryEntriesManager 的纯函数逻辑，独立成模块以便单测直接消费
// （组件内 export 的纯函数对 production knip 扫描是 dead export）。
import type { MemoryEntry, MemoryEntryBatchReviewResult } from '@shared/contract/memory';
import type { zh } from '../../../../i18n/zh';

type BatchReviewLabels = typeof zh.settings.memory.entries.batchReview;

/** 批量转正的可勾选集合：仅「可见 + candidate + 非 directive」；directive 必须逐条人工审。 */
export function visibleCandidateEntryIds(entries: MemoryEntry[], rows: Array<{ id: string }>): string[] {
  const visible = new Set(rows.map((row) => row.id));
  return entries
    .filter((entry) => entry.status === 'candidate' && entry.kind !== 'directive' && visible.has(entry.id))
    .map((entry) => entry.id);
}

/** 批量转正被跳过的条目翻成人话：已知 reason 配文案，未知原样展示，并列出条目标题。 */
export function formatBatchReviewSkippedDetail(
  skipped: MemoryEntryBatchReviewResult['skipped'],
  entries: MemoryEntry[],
  labels: BatchReviewLabels,
): string {
  const reasonLabels: Record<string, string> = labels.skippedReasonLabels;
  return skipped
    .map((item) => {
      const title = entries.find((entry) => entry.id === item.entryId)?.title || item.entryId;
      const reason = reasonLabels[item.reason] ?? item.reason;
      return labels.skippedItem.replace('{title}', title).replace('{reason}', reason);
    })
    .join(labels.skippedItemSeparator);
}
