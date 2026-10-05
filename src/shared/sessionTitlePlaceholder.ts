// ============================================================================
// 会话标题占位判断与无模型降级标题
// 自动起标题、遥测回填、CLI 回填只允许覆盖这一档。
// ============================================================================

import { stripAppshotBlocks } from './contract/appshot';

const EXACT_PLACEHOLDER_TITLES = new Set([
  'New Chat',
  'New Session',
  'New conversation',
  '新对话',
  '新会话',
  'CLI Session',
]);

/** 空白、默认档、以及 `Session ` / `CLI Session ` 前缀都还没被命过名。 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const named = title?.trim() ?? '';
  if (!named) return true;
  if (EXACT_PLACEHOLDER_TITLES.has(named)) return true;
  return named.startsWith('Session ') || named.startsWith('CLI Session ');
}

/** 剥掉 appshot 块后留给小模型和降级标题的正文。纯 appshot 用固定名。 */
export function sessionTitleSource(sourceText: string): string {
  const visibleMessage = stripAppshotBlocks(sourceText);
  return visibleMessage || (sourceText.trim().startsWith('<appshot') ? 'Appshot 会话' : sourceText);
}

/** 小模型不可用时的标题：首行，最多 50 字，超出加 `...`。 */
export function deriveFallbackSessionTitle(sourceText: string): string {
  const firstLine = sessionTitleSource(sourceText).trim().split('\n')[0] || 'Appshot 会话';
  const title = firstLine.slice(0, 50);
  return firstLine.length > 50 ? `${title}...` : title;
}
