// ============================================================================
// memoryJournalSnapshot — 变更历史快照解析（N-MEM-JOURNAL-SOURCEJUMP-FU2）
// ============================================================================
// journal 行的 before/afterContent 是 {summary,status,content} 的截断 JSON
// （journalSnapshot，上限 MEMORY.JOURNAL_SNAPSHOT_MAX_CHARS）。撤回（Undo）要拿
// before 快照整段恢复记忆，这里把它解析成可直接送 memoryEntryUpdate 的字段；
// 被截断/解析失败的快照一律标「不可恢复」——绝不用残缺内容假装恢复成功。
// ============================================================================

import { MEMORY } from '@shared/constants';
import type {
  MemoryChangeJournalRow,
  MemoryEntryStatus,
  MemoryEntryUpdateRequest,
} from '@shared/contract/memory';

/** 解析结果：ok = 可恢复；truncated = 快照被截断或解析失败；null = 没有快照（create 行） */
export type ParsedMemoryJournalSnapshot =
  | { restorable: true; title: string; content: string; status: MemoryEntryStatus }
  | { restorable: false; reason: 'truncated' }
  | null;

const SNAPSHOT_STATUSES: ReadonlySet<string> = new Set<string>([
  'candidate',
  'active',
  'rejected',
  'stale',
  'archived',
]);

/**
 * 解析 journal 行的 before 快照。快照里的 summary 列在镜像侧存的是
 * entry.title || entry.summary（updateMemoryEntry 写入口径），所以恢复时
 * summary → title。
 */
export function parseMemoryJournalSnapshot(beforeContent: string | null): ParsedMemoryJournalSnapshot {
  if (beforeContent === null) return null;
  if (beforeContent.endsWith(MEMORY.JOURNAL_SNAPSHOT_TRUNCATED_SUFFIX)) {
    return { restorable: false, reason: 'truncated' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(beforeContent);
  } catch {
    return { restorable: false, reason: 'truncated' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { restorable: false, reason: 'truncated' };
  const snapshot = parsed as { summary?: unknown; status?: unknown; content?: unknown };
  if (typeof snapshot.content !== 'string') return { restorable: false, reason: 'truncated' };
  if (typeof snapshot.status !== 'string' || !SNAPSHOT_STATUSES.has(snapshot.status)) {
    return { restorable: false, reason: 'truncated' };
  }
  return {
    restorable: true,
    title: typeof snapshot.summary === 'string' ? snapshot.summary : '',
    content: snapshot.content,
    status: snapshot.status as MemoryEntryStatus,
  };
}

/** 面板手动编辑以外的一切写入路径都是后台 actor（与 MemoryRepository/列表徽标同口径） */
export function isBackgroundMemoryActor(actor: string): boolean {
  return actor !== 'user_manual';
}

/** create 行没有「改前」可回；只有 update/delete/evict 的后台改写可撤回 */
export function isUndoableJournalRow(row: Pick<MemoryChangeJournalRow, 'actor' | 'operation'>): boolean {
  return isBackgroundMemoryActor(row.actor)
    && (row.operation === 'update' || row.operation === 'delete' || row.operation === 'evict');
}

/** 撤回 = 走既有 memoryEntryUpdate 写通道，不另开写路径；恢复到 active 时清掉 deprecatedBy */
export function journalRestoreRequest(
  entryId: string,
  snapshot: { title: string; content: string; status: MemoryEntryStatus },
): MemoryEntryUpdateRequest {
  return {
    entryId,
    title: snapshot.title,
    content: snapshot.content,
    status: snapshot.status,
    ...(snapshot.status === 'active' ? { deprecatedBy: null } : {}),
  };
}

/** 确认弹窗里的恢复内容预览（前 200 字符） */
export function snapshotPreview(content: string, maxChars = 200): string {
  return content.length > maxChars ? `${content.slice(0, maxChars)}…` : content;
}
