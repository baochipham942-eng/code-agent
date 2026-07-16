import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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
  it('uses filtered Markdown offsets after removing a think prefix', () => {
    const thinkPrefix = `<think>${'hidden reasoning '.repeat(40)}</think>`;
    const content = `${thinkPrefix}
\`\`\`neo_ui
{"fallback":"first host"}
\`\`\`
Visible separator
\`\`\`neo_ui
{"fallback":"second host"}
\`\`\``;

    const html = renderToStaticMarkup(
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
