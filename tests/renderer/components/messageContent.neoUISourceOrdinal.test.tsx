import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

vi.mock('../../../src/renderer/components/features/chat/GenerativeUI/GenerativeUIHost', () => ({
  GenerativeUIHost: ({ rawSpec, sourceOrdinal }: { rawSpec: string; sourceOrdinal: number }) => (
    <div
      data-neo-ui-fallback={(JSON.parse(rawSpec) as { fallback: string }).fallback}
      data-source-ordinal={sourceOrdinal}
    />
  ),
}));

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

describe('MessageContent neo_ui source ordinals', () => {
  // GenerativeUIHost 是 react-markdown 树内的 `code` 组件 override，markdown 改为
  // React.lazy(MarkdownCore) 懒加载后同步的 renderToStaticMarkup 只会吐 Suspense fallback、
  // 看不到 GenerativeUIHost。改用 renderToStaticMarkupAsync 等 Suspense resolve 后再取
  // markup，断言语义（ordinal 归属）与迁移前完全一致。
  it('uses filtered Markdown offsets after removing a think prefix', async () => {
    const thinkPrefix = `<think>${'hidden reasoning '.repeat(40)}</think>`;
    const content = `${thinkPrefix}
\`\`\`neo_ui
{"fallback":"first host"}
\`\`\`
Visible separator
\`\`\`neo_ui
{"fallback":"second host"}
\`\`\``;

    const html = await renderToStaticMarkupAsync(
      <MessageContent content={content} isUser={false} messageId="assistant-1" />,
    );

    const hosts = [...html.matchAll(/data-neo-ui-fallback="([^"]+)" data-source-ordinal="(\d+)"/g)]
      .map(([, fallback, ordinal]) => ({ fallback, ordinal: Number(ordinal) }));

    expect(hosts).toEqual([
      { fallback: 'first host', ordinal: 0 },
      { fallback: 'second host', ordinal: 1 },
    ]);
  });
});
