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

describe('LinkPreviewCard', () => {
  it('uses friendly label for known hostnames', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, {
        href: 'https://baochipham942.feishu.cn/docx/abc',
      }),
    );
    expect(html).toContain('飞书');
    expect(html).toContain('favicons?domain=baochipham942.feishu.cn');
  });

  it('falls back to hostname for unknown sites', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, { href: 'https://example.com/x' }),
    );
    expect(html).toContain('example.com');
  });

  it('shortens long paths', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkPreviewCard, {
        href: 'https://github.com/foo/bar/blob/main/path/to/very/long/file.tsx',
      }),
    );
    expect(html).toContain('GitHub');
    // 长 path 被截断，前缀以 … 开头
    expect(html).toMatch(/…\//);
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
