import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LinkPreviewCard,
  isRawUrlLink,
} from '../../../src/renderer/components/features/chat/MessageBubble/LinkPreviewCard';

describe('isRawUrlLink', () => {
  it('matches a raw URL where children equals href', () => {
    expect(isRawUrlLink('https://github.com/foo/bar', 'https://github.com/foo/bar')).toBe(true);
  });

  it('rejects URLs with a different label', () => {
    expect(isRawUrlLink('https://example.com', 'see here')).toBe(false);
  });

  it('rejects non-http hrefs', () => {
    expect(isRawUrlLink('mailto:a@b.com', 'mailto:a@b.com')).toBe(false);
  });

  it('handles array children whose joined text matches href', () => {
    expect(isRawUrlLink('https://x.com/foo', ['https://x.com/foo'])).toBe(true);
  });
});

describe('LinkPreviewCard（轻呈现 + favicon：raw URL 渲染为 16px 图标 + 下划线链接）', () => {
  it('renders the raw URL as an underlined link with a 16px favicon, no chip', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, {
        href: 'https://baochipham942.feishu.cn/docx/abc',
      }),
    );
    expect(html).toContain('favicons?domain=baochipham942.feishu.cn');
    expect(html).toContain('h-4 w-4');
    expect(html).toContain('text-sky-400/80');
    expect(html).toContain('decoration-sky-400/30');
    expect(html).toContain('underline');
    expect(html).toContain('>https://baochipham942.feishu.cn/docx/abc</a>');
  });

  it('does not shorten long paths — the full URL stays visible as link text', () => {
    const longUrl = 'https://github.com/foo/bar/blob/main/path/to/very/long/file.tsx';
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, { href: longUrl }),
    );
    expect(html).toContain(`>${longUrl}</a>`);
    expect(html).not.toContain('…');
  });

  it('no chip container: no rounded-md background/border block', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, { href: 'https://example.com/x' }),
    );
    expect(html).not.toContain('bg-zinc-800/60');
    expect(html).not.toContain('rounded-md');
    expect(html).not.toContain('border-zinc-700/60');
  });

  it('falls back to plain link when href is malformed', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, { href: 'not-a-url' }),
    );
    expect(html).toContain('not-a-url');
    expect(html).not.toContain('favicons');
  });

  it('opens in new tab with rel="noopener noreferrer"', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, { href: 'https://github.com/x' }),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
