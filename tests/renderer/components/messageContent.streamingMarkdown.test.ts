import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remend from 'remend';

function renderStreaming(content: string): string {
  const closed = remend(content);
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkBreaks],
      children: closed,
    }),
  );
}

describe('remend integration: streaming markdown', () => {
  it('closes incomplete bold mid-stream so it renders as <strong>', () => {
    const html = renderStreaming('正在生成 **重点内容');
    expect(html).toContain('<strong>重点内容</strong>');
    expect(html).not.toContain('**重点内容');
  });

  it('closes incomplete italic mid-stream so it renders as <em>', () => {
    const html = renderStreaming('看一下 *斜体片段');
    expect(html).toContain('<em>斜体片段</em>');
  });

  it('closes incomplete inline code so it renders as <code>', () => {
    const html = renderStreaming('试试 `someFn(');
    expect(html).toContain('<code>someFn(</code>');
  });

  it('closes incomplete strikethrough so it renders as <del>', () => {
    const html = renderStreaming('删除 ~~过时的内容');
    expect(html).toContain('<del>过时的内容</del>');
  });

  it('renders incomplete link as anchor (text visible, href neutralized) instead of raw markdown', () => {
    const html = renderStreaming('看 [文档](https://exam');
    expect(html).toContain('>文档</a>');
    expect(html).not.toContain('[文档](');
    expect(remend('看 [文档](https://exam')).toContain(
      'streamdown:incomplete-link',
    );
  });

  it('preserves IACT protocol links unchanged (regression guard)', () => {
    const cases = [
      '[发送](!send)',
      '[追加](!add)',
      '[运行](!run)',
      '[打开](!open)',
      '[预览](!preview)',
      '[复制](!copy)',
      '[CARTS-1234](!ticket)',
    ];
    for (const md of cases) {
      expect(remend(md)).toBe(md);
    }
  });

  // B+A 选项行（messageContent.iactSendChip.test.tsx）的不闪烁前提：
  // 流式中途未写完的第二个 !send 链接不得污染第一个完整链接——
  // remend 保持 `[选项一](!send)` 原样，半成品链接只中和自身 href。
  it('mid-stream incomplete second !send link leaves the first complete link intact', () => {
    const partial = '需要[选项一](!send)还是[选';
    const out = remend(partial);
    expect(out).toContain('[选项一](!send)');
    const html = renderStreaming(partial);
    expect(html).toContain('>选项一</a>');
    expect(html).not.toContain('[选项一](');
  });

  it('preserves complete markdown unchanged (no false positive close)', () => {
    const complete =
      '完整的 **粗体** 和 [链接](https://example.com) 还有 `code` 和 ~~删除~~';
    expect(remend(complete)).toBe(complete);
  });

  it('does not interfere with code fence content during streaming', () => {
    const partial = '说明:\n```typescript\nconst x = 1';
    expect(remend(partial)).toBe(partial);
  });

  it('handles multiple incomplete tokens in a single chunk', () => {
    const out = remend('**粗体没收完 *斜体也没收完 `代码也没收完');
    expect(out).toContain('**');
    expect(out).toContain('*');
    expect(out).toContain('`');
  });

  it('progressive streaming: each chunk produces valid HTML', () => {
    const full = '分析: **关键发现** 是 [此处](https://docs.example.com)';
    const chunks = [3, 8, 15, 22, full.length];
    for (const len of chunks) {
      const partial = full.slice(0, len);
      const html = renderStreaming(partial);
      expect(html.length).toBeGreaterThan(0);
      expect(html).not.toContain('<strong>**');
      expect(html).not.toContain('](http');
    }
  });
});
