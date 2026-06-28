import { describe, it, expect } from 'vitest';
import { localHtmlHrefToPath } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';

describe('localHtmlHrefToPath (本地 HTML 链接 → in-app 产物预览)', () => {
  it('file:// 本地 HTML → 去掉 file:// 的路径', () => {
    expect(localHtmlHrefToPath('file:///Users/linchen/.code-agent/work/snake.html'))
      .toBe('/Users/linchen/.code-agent/work/snake.html');
  });

  it('绝对/家目录/相对本地 HTML 路径 → 原样返回', () => {
    expect(localHtmlHrefToPath('/tmp/game.html')).toBe('/tmp/game.html');
    expect(localHtmlHrefToPath('~/work/index.htm')).toBe('~/work/index.htm');
    expect(localHtmlHrefToPath('snake.html')).toBe('snake.html');
  });

  it('http/https 网页（即便 .html 结尾）不拦 → null（按真外链处理）', () => {
    expect(localHtmlHrefToPath('https://example.com/page.html')).toBeNull();
    expect(localHtmlHrefToPath('http://x.com/a.htm')).toBeNull();
    expect(localHtmlHrefToPath('https://github.com/anthropics/claude-code/releases')).toBeNull();
  });

  it('非 HTML 本地文件 → null', () => {
    expect(localHtmlHrefToPath('file:///tmp/report.pdf')).toBeNull();
    expect(localHtmlHrefToPath('/tmp/data.json')).toBeNull();
  });

  it('空/未定义 → null', () => {
    expect(localHtmlHrefToPath(undefined)).toBeNull();
    expect(localHtmlHrefToPath('')).toBeNull();
  });
});
