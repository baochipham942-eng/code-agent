// ============================================================================
// atMentionPanelModel - @ 触发面板的纯函数（分组 / 过滤 / 目录推导）
// ============================================================================
//
// 2026-07-29 UX round2 任务 14：@ 面板从「纯文件名子串列表」升级为 WorkBuddy 形态：
// 第一组「资料库」（当前项目 ∪ 全局架 pin 候选，口径与 host 注入一致，
// 复用 libraryItemModel 的 filterPinCandidates / matchesLibraryItemSearch），
// 第二组「工作区文件」（原有 listFiles 数据源）。两组各限 8 条，键盘导航在平铺
// 序列上循环。组件只负责渲染与副作用，分组/过滤规则全部落在这里便于测试。

import type { LibraryItem } from '@shared/contract/library';
import { filterPinCandidates, matchesLibraryItemSearch } from '../../knowledge/libraryItemModel';

/** 每组最多展示条数（资料库 / 工作区文件各自独立计算）。 */
export const AT_MENTION_GROUP_LIMIT = 8;

export interface AtMentionFileMatch {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface AtMentionFileRow {
  kind: 'file';
  path: string;
  name: string;
  /** 所在目录（第二行灰字）；根目录文件为空串不渲染第二行 */
  dir: string;
  isDirectory: boolean;
}

export interface AtMentionLibraryRow {
  kind: 'library';
  item: LibraryItem;
  /** 已 pin 进本会话（行上显示 check 选中态） */
  pinned: boolean;
}

export type AtMentionRow = AtMentionFileRow | AtMentionLibraryRow;

/** 'src/foo/bar.ts' → 'src/foo'；'bar.ts' → ''。host 端 join 的分隔符平台相关，尾部分隔符统一剥掉。 */
export function deriveFileDir(path: string, name: string): string {
  if (!path.endsWith(name)) return '';
  return path.slice(0, path.length - name.length).replace(/[\\/]$/, '');
}

/** 资料库组：pin 候选（本项目 ∪ 全局）按 query 过滤（空 query 全量），封顶 limit 条。 */
export function buildLibraryRows(
  items: LibraryItem[],
  projectId: string | null,
  pinnedIds: ReadonlySet<string>,
  query: string,
  limit = AT_MENTION_GROUP_LIMIT,
): AtMentionLibraryRow[] {
  const candidates = filterPinCandidates(items, projectId);
  const trimmed = query.trim();
  const filtered = trimmed
    ? candidates.filter((item) => matchesLibraryItemSearch(item, trimmed))
    : candidates;
  return filtered.slice(0, limit).map((item) => ({
    kind: 'library',
    item,
    pinned: pinnedIds.has(item.id),
  }));
}

/** 工作区文件组：沿用旧面板的文件名子串过滤（大小写不敏感），封顶 limit 条。 */
export function buildFileRows(
  files: AtMentionFileMatch[],
  query: string,
  limit = AT_MENTION_GROUP_LIMIT,
): AtMentionFileRow[] {
  const normalized = query.trim().toLowerCase();
  return files
    .filter((file) => !normalized || file.name.toLowerCase().includes(normalized))
    .slice(0, limit)
    .map((file) => ({
      kind: 'file',
      path: file.path,
      name: file.name,
      dir: deriveFileDir(file.path, file.name),
      isDirectory: file.isDirectory,
    }));
}

/** 键盘导航的平铺序列：资料库在前、工作区文件在后（与面板渲染顺序一致）。 */
export function flattenAtMentionRows(
  libraryRows: AtMentionLibraryRow[],
  fileRows: AtMentionFileRow[],
): AtMentionRow[] {
  return [...libraryRows, ...fileRows];
}

/** 循环位移：len 为 0 时返回 0（调用方此时不应进入导航分支）。 */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}
