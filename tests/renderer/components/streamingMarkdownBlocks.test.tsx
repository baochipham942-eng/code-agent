// @vitest-environment jsdom

import React, { Suspense } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Components } from 'react-markdown';
import MarkdownCore from '../../../src/renderer/components/features/chat/MessageBubble/MarkdownCore';
import {
  MarkdownRenderer,
} from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';
import {
  splitStreamingMarkdownBlocks,
  updateStreamingMarkdownBlockState,
} from '../../../src/renderer/components/features/chat/MessageBubble/streamingMarkdownBlocks';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

const NO_COMPONENTS: Components = {};

describe('streaming markdown blocks', () => {
  afterEach(() => cleanup());

  it('keeps completed block keys and contents stable while only the tail grows', () => {
    const first = splitStreamingMarkdownBlocks('# 标题\n\n第一段。\n\n尾段');
    const second = splitStreamingMarkdownBlocks('# 标题\n\n第一段。\n\n尾段继续增长');

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(second.slice(0, -1)).toEqual(first.slice(0, -1));
    expect(second.at(-1)?.key).toBe(first.at(-1)?.key);
    expect(second.at(-1)?.content).not.toBe(first.at(-1)?.content);
  });

  it('reuses completed block objects when the incremental state advances', () => {
    const first = updateStreamingMarkdownBlockState(
      null,
      '# 标题\n\n第一段。\n\n尾段',
    );
    const second = updateStreamingMarkdownBlockState(
      first,
      '# 标题\n\n第一段。\n\n尾段继续增长',
    );

    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks[1]).toBe(first.blocks[1]);
    expect(second.blocks[2]).not.toBe(first.blocks[2]);
  });

  it('keeps a top-level list and fenced code as single blocks', () => {
    const blocks = splitStreamingMarkdownBlocks([
      '- 第一项',
      '- 第二项',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '尾段',
    ].join('\n'));

    expect(blocks.map((block) => block.content)).toEqual([
      '- 第一项\n- 第二项\n\n',
      '```ts\nconst value = 1;\n```\n\n',
      '尾段',
    ]);
  });

  it('applies remend to the unfinished tail only', () => {
    const blocks = splitStreamingMarkdownBlocks('完成的 **粗体**。\n\n正在生成 **尾部');

    expect(blocks[0].content).toBe('完成的 **粗体**。\n\n');
    expect(blocks[0].isTail).toBe(false);
    expect(blocks[1].content).toBe('正在生成 **尾部**');
    expect(blocks[1].isTail).toBe(true);
  });

  it('falls back to one tail block for cross-block reference definitions', () => {
    const source = '阅读 [文档][neo]。\n\n[neo]: https://example.com';
    const blocks = splitStreamingMarkdownBlocks(source);

    expect(blocks).toEqual([{ key: 'markdown-block-0', content: source, sourceOffset: 0, isTail: true }]);
  });

  it('does not render completed sibling blocks again when streaming content appends', async () => {
    const renders = new Map<string, number>();
    const components: Components = {
      p({ children }) {
        const text = React.Children.toArray(children).join('');
        renders.set(text, (renders.get(text) ?? 0) + 1);
        return <p>{children}</p>;
      },
    };
    const initial = '完成块 A。\n\n完成块 B。\n\n尾';
    const view = render(
      <MarkdownRenderer content={initial} components={components} isStreaming />,
    );
    await waitFor(() => expect(view.container.querySelectorAll('p')).toHaveLength(3));
    const firstParagraph = view.container.querySelectorAll('p')[0];
    const firstRenderCount = renders.get('完成块 A。');

    view.rerender(
      <MarkdownRenderer content={`${initial}部继续`} components={components} isStreaming />,
    );
    await waitFor(() => expect(view.container.textContent).toContain('尾部继续'));

    expect(view.container.querySelectorAll('p')[0]).toBe(firstParagraph);
    expect(renders.get('完成块 A。')).toBe(firstRenderCount);
    expect(renders.get('完成块 B。')).toBe(1);
  });
});

describe('completed markdown byte equivalence', () => {
  const documents = [
    '# 标题\n\n正文含 **粗体**、`code` 与 [链接](https://example.com)。',
    '- 第一项\n- 第二项\n\n> 引用\n> 第二行',
    '| A | B |\n|---|---:|\n| 1 | 2 |\n\n~~删除~~ 与 $x^2$',
    '```ts\nconst answer = 42;\n```\n\n![图](file:///tmp/demo.png)',
  ];

  it.each(documents)('matches the legacy single-document renderer byte for byte', async (content) => {
    const legacy = await renderToStaticMarkupAsync(
      <Suspense fallback={<div>{content}</div>}>
        <MarkdownCore
          content={content}
          gfm
          math
          breaks
          allowSchemes={['neo://']}
          components={NO_COMPONENTS}
        />
      </Suspense>,
    );
    const current = await renderToStaticMarkupAsync(
      <MarkdownRenderer content={content} components={NO_COMPONENTS} isStreaming={false} />,
    );

    expect(current).toBe(legacy);
  });
});
