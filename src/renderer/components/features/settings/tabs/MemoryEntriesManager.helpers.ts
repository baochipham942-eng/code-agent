// MemoryEntriesManager 的纯函数逻辑，独立成模块以便单测直接消费
// （组件内 export 的纯函数对 production knip 扫描是 dead export）。
import type { MemoryEntry, MemoryEntryBatchReviewResult } from '@shared/contract/memory';
import type { zh } from '../../../../i18n/zh';

type BatchReviewLabels = typeof zh.settings.memory.entries.batchReview;

/** 敏感信息 guard（guardMemoryMetadata）落库时把 metadata 里任何 `sessionId` 键 redact 成这个哨兵串。 */
const REDACTED_SESSION_ID = '***REDACTED***';

/** 可作会话 id 用的值：非空且不是 redact 哨兵（哨兵与缺失同视，不能拿去探测/展示/跳转）。 */
function usableSessionId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value && value !== REDACTED_SESSION_ID ? value : null;
}

/** 来源会话引用：sessionId 优先条目记录列（不过 metadata，不被 redact），证据行兜底。 */
export interface MemoryEntrySourceSessionRef {
  sessionId: string | null;
  messageId: string | null;
}

/**
 * 解析条目的来源会话与落点消息（N-MEM-JOURNAL-SOURCEJUMP ② r3）。
 * messageId 的取证口径：先取与来源会话精确同会话的证据行；没有时，若条目自带顶层
 * sessionId（记录列），接受 sessionId 被 redact/缺失的证据行——它们无法证明来自别的
 * 会话；sessionId 是具体值且不等于来源会话的证据行（明确来自别的会话）一律跳过。
 */
export function findSourceSessionRef(entry: MemoryEntry | null | undefined): MemoryEntrySourceSessionRef {
  if (!entry) return { sessionId: null, messageId: null };
  const sessionId = usableSessionId(entry.sessionId)
    ?? entry.evidence
      .map((item) => usableSessionId(item.sessionId))
      .find((id): id is string => id !== null)
    ?? null;
  if (!sessionId) return { sessionId: null, messageId: null };

  const exact = entry.evidence.find(
    (item) => usableSessionId(item.sessionId) === sessionId && item.messageId,
  );
  if (exact?.messageId) return { sessionId, messageId: exact.messageId };

  if (usableSessionId(entry.sessionId)) {
    const notProvablyForeign = entry.evidence.find(
      (item) => !usableSessionId(item.sessionId) && item.messageId,
    );
    if (notProvablyForeign?.messageId) return { sessionId, messageId: notProvablyForeign.messageId };
  }
  return { sessionId, messageId: null };
}

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
