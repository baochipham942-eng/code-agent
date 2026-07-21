// ============================================================================
// Library Pins - 会话 pinned 资料库条目的上下文注入块（Batch 2 L2）
// ============================================================================
//
// 只注入索引/摘要（标题 + 路径 + 摘要 + 标签），正文按需 Read——对齐
// "选中再进上下文"原则，不做全库静默注入。

import { getLibraryService } from '../../../services/library/libraryService';
import type { LibraryItem } from '../../../../shared/contract/library';
import { recordMemoryInjectionTrace } from '../../../memory/memoryInjectionTrace';
import type { ContextAssemblyCtx } from './shared';
import { appendPromptBlockWithinBudget } from './promptBudget';

/**
 * pin 状态指纹，进 dynamic prompt cache key：pin 变更即失效重建。
 * DB 未就绪（如纯单测环境）时降级为固定值，不影响 key 稳定性。
 */
export function getSessionPinFingerprint(sessionId: string): string {
  try {
    const pin = getLibraryService().getPin(sessionId);
    return pin.itemIds.length > 0 ? `${pin.addedAt}:${pin.itemIds.join(',')}` : 'no-pins';
  } catch {
    return 'no-pins';
  }
}

/**
 * 构建 pinned 资料索引块；无 pin 或服务不可用时返回 null。
 */
export function buildPinnedLibraryBlock(sessionId: string): { block: string | null; count: number } {
  let items: LibraryItem[];
  try {
    items = getLibraryService().getPinnedItems(sessionId);
  } catch {
    return { block: null, count: 0 };
  }
  if (items.length === 0) return { block: null, count: 0 };

  const lines = items.map((item) => {
    const parts = [`- ${item.title}（${item.kind}）: ${item.pathOrUri}`];
    if (item.summary) parts.push(`  摘要: ${item.summary}`);
    if (item.tags.length > 0) parts.push(`  标签: ${item.tags.join(' / ')}`);
    return parts.join('\n');
  });

  const block = [
    '<pinned_library_resources>',
    '用户为本会话 pin 了以下资料库条目（仅索引，正文未注入）。需要内容时按需读取：本地路径用 Read 工具，URL 用网页抓取工具。',
    '回答中引用了其中材料时，必须标注来源（文档名或库内路径）。',
    ...lines,
    '</pinned_library_resources>',
  ].join('\n');

  return { block, count: items.length };
}

/**
 * messageBuild 注入入口：预算内追加 pinned 索引块 + 记录注入 trace（进知识面板审计列表）。
 * 返回追加后的 systemPrompt（无 pin 时原样返回）。
 */
export function appendPinnedLibraryPromptBlock(
  systemPrompt: string,
  ctx: ContextAssemblyCtx,
  appendedBlocks: Map<string, string>,
): string {
  const { block, count } = buildPinnedLibraryBlock(ctx.runtime.sessionId);
  if (!block) return systemPrompt;

  const appended = appendPromptBlockWithinBudget(systemPrompt, block, 'library pins', ctx);
  const injected = appended !== systemPrompt;
  recordMemoryInjectionTrace({
    blockType: 'library_pins',
    trigger: 'session-pin',
    chars: block.length,
    injected,
    source: 'library',
    count,
    sessionId: ctx.runtime.sessionId,
  });
  if (injected) {
    appendedBlocks.set('library pins', block);
  }
  return appended;
}
