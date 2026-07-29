// ============================================================================
// libraryItemModel - 资料库条目纯函数（搜索 / pin 候选口径 / 选择剪枝）
// ============================================================================
//
// 口径契约（2026-07-29 UX round2 任务 9a / 任务 14）：@ 面板资料库组与 LibraryPanel
// 共用这里的搜索与范围规则，避免「pin 选择器里看得到、资料库页找不到」的观感断裂。
// pin 候选 = 当前项目 ∪ 全局架（与 host 端注入口径一致），并按 scope 分组展示。

import type { LibraryItem } from '@shared/contract/library';

/** 标题 / 摘要 / 路径 / 标签任一命中即算匹配（大小写不敏感）。 */
export function matchesLibraryItemSearch(item: LibraryItem, query: string): boolean {
  const haystack = [item.title, item.summary, item.pathOrUri, ...item.tags]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

/**
 * 本会话可 pin 的候选：当前项目条目 + 全局架条目（其他项目不进候选）。
 * projectId 为 null 时只剩全局架。
 */
export function filterPinCandidates(items: LibraryItem[], projectId: string | null): LibraryItem[] {
  return items.filter((item) => item.projectId === projectId || item.projectId === null);
}

/** pin 候选按归属分组：本项目在前、全局架在后。 */
export function groupPinCandidates(items: LibraryItem[]): { project: LibraryItem[]; global: LibraryItem[] } {
  return {
    project: items.filter((item) => item.projectId !== null),
    global: items.filter((item) => item.projectId === null),
  };
}

/** 列表刷新/切 scope 后，剪掉已不存在的选中 id，避免浮条计数与列表脱节。 */
export function pruneLibrarySelection(selectedIds: Set<string>, items: LibraryItem[]): Set<string> {
  const existing = new Set(items.map((item) => item.id));
  const next = new Set([...selectedIds].filter((id) => existing.has(id)));
  return next.size === selectedIds.size ? selectedIds : next;
}
