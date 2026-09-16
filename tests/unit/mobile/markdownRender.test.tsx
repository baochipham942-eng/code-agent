// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Markdown } from '../../../packages/mobile/src/features/sessions/markdown/Markdown';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionHistory } from '../../../src/shared/contract/companionLibrary';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

const text = messages('zh');
const md = (source: string) => render(<div className="md"><Markdown source={source} copyLabel="复制" copiedLabel="已复制" /></div>).container;

describe('助手正文 Markdown 渲染（N-MOBILE-MARKDOWN-RENDER，爸 09-17 ④A）', () => {
  afterEach(cleanup);

  it('加粗 / 斜体 / 删除线 / 行内代码', () => {
    const c = md('这是 **加粗**、*斜体*、_也斜体_、~~删掉~~ 和 `A19`，snake_case_name 不变斜体');
    expect(c.querySelector('strong')!.textContent).toBe('加粗');
    expect(Array.from(c.querySelectorAll('em'), node => node.textContent)).toEqual(['斜体', '也斜体']);
    expect(c.querySelector('del')!.textContent).toBe('删掉');
    expect(c.querySelector('code')!.textContent).toBe('A19');
    expect(c.textContent).toContain('snake_case_name');
    expect(md('***都要***').querySelector('strong em, em strong')!.textContent).toBe('都要');
  });

  it('有序 / 无序列表，嵌套最多两层，更深的按第二层画', () => {
    const c = md('- 一\n  - 一.一\n      - 一.一.一\n- 二\n\n1. 甲\n2. 乙');
    expect(c.querySelectorAll('ul > li')).toHaveLength(4);
    expect(Array.from(c.querySelectorAll('ul ul > li'), node => node.textContent)).toEqual(['一.一', '一.一.一']);
    expect(c.querySelector('ul ul ul')).toBeNull();
    expect(Array.from(c.querySelectorAll('ol > li'), node => node.textContent)).toEqual(['甲', '乙']);
    // 不从 1 起的数字行打断不了段落
    expect(md('1.5 倍速\n2026. 年').querySelector('ol')).toBeNull();
  });

  it('代码块：等宽不折行容器 + 右上复制', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const c = md('看这段：\n\n```ts\nconst a = **1**;\n# 不是标题\n```');
    const block = c.querySelector('.md-code')!;
    expect(block.querySelector('pre > code')!.textContent).toBe('const a = **1**;\n# 不是标题');
    expect(block.querySelector('strong, .md-h')).toBeNull();
    fireEvent.click(block.querySelector('button.md-copy')!);
    expect(writeText).toHaveBeenCalledWith('const a = **1**;\n# 不是标题');
    await waitFor(() => expect(block.querySelector('button.md-copy')!.textContent).toBe('已复制'));
  });

  it('链接显示文字、target=_blank 交给系统浏览器', () => {
    const a = md('见 [发布会页面](https://example.com/launch)').querySelector('a')!;
    expect(a.textContent).toBe('发布会页面');
    expect(a.getAttribute('href')).toBe('https://example.com/launch');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('引用画成 blockquote，分隔线画成 hr', () => {
    const c = md('> 引用的话\n\n---\n\n后文');
    expect(c.querySelector('blockquote')!.textContent).toBe('引用的话');
    expect(c.querySelector('hr')).not.toBeNull();
  });

  it('降级：标题是加粗段落不放大', () => {
    const c = md('## 主要参数\n正文');
    expect(c.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
    expect(c.querySelector('p.md-h > strong')!.textContent).toBe('主要参数');
  });

  it('降级：图片不内联加载，显示成链接', () => {
    const c = md('![参数截图](https://example.com/a.png)');
    expect(c.querySelector('img')).toBeNull();
    const a = c.querySelector('a')!;
    expect(a.textContent).toBe('参数截图');
    expect(a.getAttribute('href')).toBe('https://example.com/a.png');
  });

  it('XSS：<script> 按文本显示、不生成节点', () => {
    const c = md('<script>window.__mdXss = 1</script>');
    expect(c.querySelector('script')).toBeNull();
    expect(c.textContent).toContain('<script>window.__mdXss = 1</script>');
    expect((window as unknown as { __mdXss?: number }).__mdXss).toBeUndefined();
  });

  it('XSS：<img onerror> 按文本显示、不生成节点', () => {
    const c = md('<img src=x onerror="window.__mdXss2 = 1">');
    expect(c.querySelector('img, [onerror]')).toBeNull();
    expect(c.textContent).toContain('<img src=x onerror="window.__mdXss2 = 1">');
    expect((window as unknown as { __mdXss2?: number }).__mdXss2).toBeUndefined();
  });

  it('XSS：javascript: 链接不生成链接节点，只留文字', () => {
    const c = md('[点我](javascript:alert(1)) 和 [也点我](JavaScript:void(0))');
    expect(c.querySelector('a')).toBeNull();
    expect(c.querySelector('[href]')).toBeNull();
    expect(c.textContent).toBe('点我 和 也点我');
  });

  it('表格：保留行列，放在横滑容器里，首列 sticky、不画常驻滚动条、右缘渐隐', () => {
    const c = md('| 参数 | iPhone 17 | Pixel 10 |\n|---|---|---|\n| 处理器 | A19 | Tensor G5 |\n| 主摄 | 4800 万 | 5000 万 |');
    const wrap = c.querySelector('.md-table')!;
    expect(wrap.querySelectorAll('thead th')).toHaveLength(3);
    expect(Array.from(wrap.querySelectorAll('tbody tr'), row => Array.from(row.children, cell => cell.textContent))).toEqual([['处理器', 'A19', 'Tensor G5'], ['主摄', '4800 万', '5000 万']]);
    const css = readFileSync('packages/mobile/src/styles.css', 'utf8');
    expect(css).toMatch(/\.md \.md-table \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.md \.md-table \{[^}]*mask-image: linear-gradient/);
    expect(css).toMatch(/\.md \.md-table,[^{]*\{[^}]*scrollbar-width: none/);
    expect(css).toMatch(/\.md \.md-table::-webkit-scrollbar[^{]*\{[^}]*display: none/);
    expect(css).toMatch(/\.md th, \.md td \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.md td:first-child, \.md th:first-child \{[^}]*position: sticky; left: 0/);
  });

  it('流式：未闭合的 ** 与代码围栏按文本兜底，闭合后才渲染；前面的段落节点不重建', () => {
    const view = render(<Markdown source={'第一段\n\n这是 **加'} copyLabel="复制" copiedLabel="已复制" />);
    const first = view.container.querySelector('p')!;
    expect(view.container.querySelector('strong')).toBeNull();
    expect(view.container.textContent).toContain('这是 **加');
    view.rerender(<Markdown source={'第一段\n\n这是 **加粗**\n\n```js\nconst a = 1;\n# 注释'} copyLabel="复制" copiedLabel="已复制" />);
    expect(view.container.querySelector('p')).toBe(first);
    expect(view.container.querySelector('strong')!.textContent).toBe('加粗');
    expect(view.container.querySelector('pre, .md-h')).toBeNull();
    expect(view.container.textContent).toContain('```js\nconst a = 1;\n# 注释');
    view.rerender(<Markdown source={'第一段\n\n这是 **加粗**\n\n```js\nconst a = 1;\n# 注释\n```'} copyLabel="复制" copiedLabel="已复制" />);
    expect(view.container.querySelector('p')).toBe(first);
    expect(view.container.querySelector('pre > code')!.textContent).toBe('const a = 1;\n# 注释');
  });

  it('会话里：助手正文渲染、用户消息不渲染，截断提示仍在正文容器里', () => {
    const history = { messages: [
      { id: 'u1', role: 'user', content: '把 **这个** 加粗' },
      { id: 'a1', role: 'assistant', content: '好的，**已加粗**\n\n- 一', truncated: true },
    ] } as unknown as CompanionHistory;
    const { container } = render(<CompanionConversation history={history} events={[] as CompanionEvent[]} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
      respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} />);
    const mine = container.querySelector('.from-user')!;
    expect(mine.querySelector('strong')).toBeNull();
    expect(mine.textContent).toContain('把 **这个** 加粗');
    const body = container.querySelector('.lan-message:not(.from-user) .assistant-text')!;
    expect(body.tagName).toBe('DIV');
    expect(body.classList.contains('md')).toBe(true);
    expect(body.querySelector('strong')!.textContent).toBe('已加粗');
    expect(body.querySelector('ul > li')!.textContent).toBe('一');
    expect(body.querySelector('small.notice')!.textContent).toBe(text.historyTruncated);
  });
});
