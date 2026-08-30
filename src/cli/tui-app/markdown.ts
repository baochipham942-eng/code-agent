// ============================================================================
// markdown → ANSI 字符串渲染（marked + marked-terminal）
// 独立成模块：MessageView 渲染与 layout.ts 行数测量共用同一实现，防止漂移。
// ============================================================================

import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

/** markdown → ANSI 字符串（每个 Marked 实例绑定当前宽度，交给 reflow 换行） */
export function renderMarkdown(markdown: string, width: number): string {
  const marked = new Marked(markedTerminal({
    width: Math.max(width, 20),
    reflowText: true,
    showSectionPrefix: false,
  }));
  const rendered = marked.parse(markdown, { async: false });
  return rendered.trimEnd();
}

/** 渲染后的视觉行数（marked-terminal 已按宽度 reflow，行数精确） */
export function markdownLineCount(markdown: string, width: number): number {
  if (!markdown) return 0;
  return renderMarkdown(markdown, width).split('\n').length;
}
