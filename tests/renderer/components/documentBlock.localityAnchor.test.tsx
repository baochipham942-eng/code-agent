// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      common: { delete: '删除' },
      generativeUI: {
        rewrite: '重写',
        simplify: '精简',
        insertAfter: '在后面插入',
        listItem: '列表项',
        paragraph: '段落',
        document: '文档',
        paragraphUnit: '段',
        wordUnit: '字',
        copied: '已复制',
        copy: '复制',
      },
    },
  }),
}));

import { DocumentBlock } from '../../../src/renderer/components/features/chat/MessageBubble/DocumentBlock';

const spec = JSON.stringify({
  title: '复杂文档',
  wordCount: 10,
  paragraphs: [
    { index: 0, type: 'heading', text: '标题', level: 1, textFingerprint: 'fp-0' },
    // index=2 是 document.xml 的空段落，预览不渲染；目标必须保留真实间隙 index=3。
    { index: 1, type: 'paragraph', text: '空段之前', textFingerprint: 'fp-1' },
    { index: 3, type: 'paragraph', text: '空段之后目标', textFingerprint: 'fp-3' },
  ],
});

beforeEach(() => sendPrompt.mockClear());
afterEach(() => cleanup());

describe('DocumentBlock XML paragraph locator', () => {
  it('点击空段后的正文，发送真实 paragraphIndex 与结构化 docx 锚点', () => {
    render(<DocumentBlock spec={spec} filePath="/tmp/locator-word-complex.docx" />);
    fireEvent.click(screen.getByText('空段之后目标'));
    fireEvent.click(screen.getByText('重写'));

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const [prompt, context] = sendPrompt.mock.calls[0];
    expect(prompt).toContain('paragraph_index=3');
    expect(prompt).toContain('必须使用 3');
    expect(context.localityAnchor).toMatchObject({
      kind: 'docx',
      filePath: '/tmp/locator-word-complex.docx',
      paragraphIndex: 3,
      text: '空段之后目标',
    });
  });
});
