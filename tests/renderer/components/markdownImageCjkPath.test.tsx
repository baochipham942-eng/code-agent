// @vitest-environment jsdom
// 中文（及一切非 ASCII）文件名的正文图片 404 —— 双重编码。
//
// 链路：markdown 渲染器按 CommonMark 把 URL 里的非 ASCII 编码一次 →
// 该已编码串被当成文件路径存进 asset.path → resolveFileUrl 的 URLSearchParams 再编码一次 →
// 服务器只解一次 → 拿到字面量 `%E4%B8%AD…` 当文件名 → fs.stat 找不到 → 404。
// 英文名没东西可编码，所以长期没被发现。
//
// 探针纪律：光测解码函数不够——那只证明函数会解码，不证明产品链路对。
// 所以下面第二组直接断言**渲染出来的 img src 只解一次就等于真实路径**，
// 这一条在修复前必红（会解出还带 % 转义的中间态）。
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  decodeMarkdownImagePath,
  MarkdownMediaImage,
} from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

const CJK = '/tmp/x/这是一张中文名图片.png';

describe('decodeMarkdownImagePath', () => {
  it('把渲染器编码过的中文路径解回真实路径', () => {
    expect(decodeMarkdownImagePath(encodeURI(CJK))).toBe(CJK);
  });

  it('data: / http(s): / blob: 原样返回——它们的百分号编码是 URL 语义的一部分', () => {
    for (const u of ['data:image/png;base64,AAA%20BBB', 'https://e.com/a%20b.png', 'blob:http://x/y%2Fz']) {
      expect(decodeMarkdownImagePath(u)).toBe(u);
    }
  });

  it('文件名里有裸 % 时不抛异常，原样返回', () => {
    // decodeURIComponent('50%off.png') 会抛 URIError
    expect(decodeMarkdownImagePath('/tmp/50%off.png')).toBe('/tmp/50%off.png');
  });

  it('已经是真实路径（未编码）时不动它', () => {
    expect(decodeMarkdownImagePath(CJK)).toBe(CJK);
    expect(decodeMarkdownImagePath('/tmp/plain.png')).toBe('/tmp/plain.png');
  });
});

describe('正文中文名图片的实际 src', () => {
  // 正对照：英文名走同一条路，任何时候都该是对的。它要是也红，说明测试本身坏了。
  const srcOf = (path: string): string => {
    const html = renderToStaticMarkup(
      <MarkdownMediaImage src={encodeURI(path)} alt="x" messageId="m1" />,
    );
    return html.match(/src="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&') ?? '';
  };

  it('中文名：src 解一次码后等于真实路径（修复前会剩下 % 转义 → 服务器 404）', () => {
    const src = srcOf(CJK);
    const pathParam = new URLSearchParams(src.split('?')[1] ?? '').get('path');
    expect(pathParam).toBe(CJK);
    expect(pathParam).not.toContain('%');
  });

  it('正对照·英文名：同一条路径本来就是对的', () => {
    const ascii = '/tmp/x/plain-name.png';
    const pathParam = new URLSearchParams(srcOf(ascii).split('?')[1] ?? '').get('path');
    expect(pathParam).toBe(ascii);
  });
});
