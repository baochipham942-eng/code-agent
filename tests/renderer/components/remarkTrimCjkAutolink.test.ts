// @vitest-environment jsdom
// 中文正文里的自动链接不得把标点连同后面的字一起吞进 URL。
// 2026-08-02 产品负责人实测：「已打开 https://example.com，页面标题为 …」渲染出的
// 链接指向 https://example.com，页面标题为 —— 一个不存在的地址。上游按半角标点表
// 收尾，全角标点不在表里，于是一路吃到下一个空白。中文句子之间不带空格，
// 等于中文正文里几乎每个自动链接都是坏的。

import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { remarkTrimCjkAutolink } from '../../../src/renderer/components/features/chat/MessageBubble/remarkTrimCjkAutolink';

function parse(src: string): Root {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkTrimCjkAutolink);
  return processor.runSync(processor.parse(src)) as Root;
}

function links(src: string): string[] {
  const found: string[] = [];
  const walk = (node: { type: string; url?: string; children?: unknown[] }): void => {
    if (node.type === 'link' && node.url) found.push(node.url);
    for (const child of (node.children ?? []) as typeof node[]) walk(child);
  };
  walk(parse(src) as never);
  return found;
}

/** 正文里的可见文字（含被退回的标点），用来证明裁下来的字符没被吃掉。 */
function plainText(src: string): string {
  let out = '';
  const walk = (node: { type: string; value?: string; children?: unknown[] }): void => {
    if (node.type === 'text' && node.value) out += node.value;
    for (const child of (node.children ?? []) as typeof node[]) walk(child);
  };
  walk(parse(src) as never);
  return out;
}

describe('remarkTrimCjkAutolink — 自动链接尾部的全角标点退回正文', () => {
  it.each([
    ['已打开 https://example.com，页面标题为 x', 'https://example.com'],
    ['见 https://example.com。下一句', 'https://example.com'],
    ['（参考 https://example.com）后面', 'https://example.com'],
    ['结尾问号 https://example.com？', 'https://example.com'],
    ['引号 https://example.com”尾', 'https://example.com'],
    ['顿号 https://example.com、再一个', 'https://example.com'],
  ])('%s → %s', (src, expected) => {
    expect(links(src)[0]).toBe(expected);
  });

  it('裁下来的标点原样留在正文里，一个字符都不丢', () => {
    const src = '已打开 https://example.com，页面标题为 x';
    expect(plainText(src)).toBe(src);
  });

  it('半角标点不动——上游对它们的处理本来就是对的', () => {
    expect(links('英文 https://example.com, next')[0]).toBe('https://example.com');
    // 半角右括号是合法 URL 字符，上游已按成对规则处理，这里不许再咬一口
    expect(links('见 https://en.wikipedia.org/wiki/A_(b)')[0]).toBe('https://en.wikipedia.org/wiki/A_(b)');
  });

  it('显式 markdown 链接一个字都不改——URL 是作者自己给的', () => {
    expect(links('[点这里](https://example.com，keep)')[0]).toBe('https://example.com，keep');
  });

  it('URL 路径中间的全角标点不受影响，只裁尾部', () => {
    expect(links('见 https://example.com/a，b 结束')[0]).toBe('https://example.com/a');
  });

  it('多个链接各自收尾，互不影响', () => {
    expect(links('先 https://a.com，再 https://b.com。完')).toEqual(['https://a.com', 'https://b.com']);
  });
});

// 上面测的是插件本身。插件挂没挂进 MarkdownCore 是另一半——
// keepframe 那单刚栽过：store 半有测试、组件接线半没有，真机才发现不通。
describe('MarkdownCore 接线：插件确实挂在渲染链上', () => {
  it('渲染出来的 href 不含全角标点', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const React = (await import('react')).default;
    const { default: MarkdownCore } = await import(
      '../../../src/renderer/components/features/chat/MessageBubble/MarkdownCore'
    );

    render(React.createElement(MarkdownCore, {
      content: '已打开 https://example.com，页面标题为 x',
    }));

    const link = screen.getByRole('link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.com');
    // 切下来的标点必须还在正文里
    expect(document.body.textContent).toContain('，页面标题为');
    cleanup();
  });
});
