import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

function makeErrorNode(content: string): TraceNode {
  return {
    id: 'system-error-1',
    type: 'system',
    subtype: 'error',
    content,
    timestamp: 100,
  } as TraceNode;
}

// 系统错误节点此前把 node.content（往往是堆栈/工程报错）原样直出。现在拆成
// 两层：一句人话摘要（能分类走 humanizeToolError，分不了类走通用兜底）默认
// 可见，原文折叠在「查看详情」后面——回归钉子：若改回原文直出，下面的断言
// 会真红（既没有分类摘要文案，也没有 aria-expanded 折叠按钮）。
describe('TraceNodeRenderer 系统错误节点 — 两层人话化', () => {
  it('可分类错误（429 限流）显示分类摘要，原文默认折叠不裸露', () => {
    const raw = 'Error: HTTP 429 Too Many Requests from upstream provider xyz-service';
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, { node: makeErrorNode(raw) }),
    );

    expect(html).toContain('请求过于频繁，被限流');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(raw);
  });

  it('无法分类的错误走通用兜底文案，原文同样默认折叠不裸露', () => {
    const raw = 'TypeError: Cannot read properties of undefined (reading \'foo\') at bar.ts:42:7';
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, { node: makeErrorNode(raw) }),
    );

    expect(html).toContain('执行时出了问题');
    expect(html).toContain('可以重试一次，或换个说法再试试。');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(raw);
  });
});
