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
