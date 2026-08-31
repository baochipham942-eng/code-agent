// ============================================================================
// tui-app/markdown.ts — marked + marked-terminal 渲染单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import { markdownLineCount, renderMarkdown } from '../../../../src/cli/tui-app/markdown';

describe('renderMarkdown', () => {
  it('顶层 bold 渲染成 ANSI 加粗，不留字面 **', () => {
    const out = renderMarkdown('**加粗**普通', 80);
    expect(out).not.toContain('**');
    expect(out).toContain('加粗');
  });

  it('紧凑列表项内的 bold / code 也渲染（marked-terminal text 渲染器补丁）', () => {
    // marked-terminal@7.3.0 的 text 渲染器收 token 对象时吐原文，
    // 列表项内联样式会全部漏成字面量；覆盖成 parseInline 后修复
    const out = renderMarkdown('* **写代码/改代码**：实现功能\n* 用 `npm test` 跑测试', 90);
    expect(out).not.toContain('**');
    expect(out).not.toContain('`npm test`');
    expect(out).toContain('写代码/改代码');
    expect(out).toContain('npm test');
  });

  it('嵌套列表不漏 **', () => {
    const out = renderMarkdown('* 外层 **粗**\n  * 内层 `code`', 90);
    expect(out).not.toContain('**');
  });
});

describe('markdownLineCount', () => {
  it('空串 0 行，渲染后按实际行数', () => {
    expect(markdownLineCount('', 80)).toBe(0);
    expect(markdownLineCount('一行', 80)).toBe(1);
  });
});
