// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment, PresentationPagePreviewResult } from '../../../src/shared/contract';

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

import { PresentationPagePicker } from '../../../src/renderer/components/PresentationPagePicker';
import { PresentationPreview } from '../../../src/renderer/components/PreviewPanel';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';

const revision = 'a'.repeat(64);
const readyPreview: PresentationPagePreviewResult = {
  filePath: '/tmp/deck.pptx',
  state: 'ready',
  pages: [
    {
      title: '蓝色封面',
      text: ['蓝色封面'],
      screenshotPath: '/tmp/cache/deck-1.jpg',
      locator: {
        version: 1,
        artifact: { kind: 'presentation', filePath: '/tmp/deck.pptx', revision: { algorithm: 'sha256', value: revision } },
        target: { kind: 'ppt-slide', displayIndex: 0, relationshipId: 'rId7', slidePartName: 'ppt/slides/slide7.xml', textFingerprint: 'fp7' },
        display: { label: 'deck.pptx', excerpt: '蓝色封面' },
      },
    },
    {
      title: '经营数据',
      text: ['经营数据', '收入 100'],
      screenshotPath: '/tmp/cache/deck-2.jpg',
      locator: {
        version: 1,
        artifact: { kind: 'presentation', filePath: '/tmp/deck.pptx', revision: { algorithm: 'sha256', value: revision } },
        target: { kind: 'ppt-slide', displayIndex: 1, relationshipId: 'rId2', slidePartName: 'ppt/slides/slide2.xml', textFingerprint: 'fp2' },
        display: { label: 'deck.pptx', excerpt: '经营数据' },
      },
    },
  ],
};

function assertPositivePickerState(container: HTMLElement, targetTitle: string): void {
  expect(container.innerHTML).toContain('data-testid="presentation-page-picker"');
  expect(container.textContent).toContain(targetTitle);
  expect(container.querySelector('[aria-pressed="true"]')).not.toBeNull();
  expect(screen.getByPlaceholderText('这里改成…（回车发送）')).not.toBeNull();
}

function selectSecondPageAndSend(): unknown {
  const pageButtons = Array.from(document.querySelectorAll('button[aria-pressed]'));
  expect(pageButtons).toHaveLength(2);
  fireEvent.click(pageButtons[1]);
  expect(pageButtons[1].getAttribute('aria-pressed')).toBe('true');
  const input = screen.getByPlaceholderText('这里改成…（回车发送）');
  fireEvent.change(input, { target: { value: '把收入改成 120' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt.mock.calls[0][0]).toContain('slide_index=1');
  return sendPrompt.mock.calls[0][1];
}

beforeEach(() => {
  sendPrompt.mockClear();
  Object.defineProperty(window, 'domainAPI', {
    configurable: true,
    value: { invoke: vi.fn().mockResolvedValue({ success: true, data: readyPreview }) },
  });
});

afterEach(() => cleanup());

describe('PresentationPagePicker 截图墙与降级链', () => {
  it('LibreOffice 可用：组件、目标页、选中态、反馈入口和截图都正向渲染', () => {
    const view = render(<PresentationPagePicker title="deck.pptx" filePath="/tmp/deck.pptx" preview={readyPreview} />);
    assertPositivePickerState(view.container, '经营数据');
    expect(view.container.innerHTML).toContain('<img');
    expect(view.container.innerHTML).toContain('deck-2.jpg');
  });

  it.each([
    ['libreoffice-missing', '本机没有 LibreOffice'],
    ['conversion-failed', '截图转换失败'],
  ] as const)('%s：正向可选页与反馈入口成立后，才断言没有截图', (state, message) => {
    const preview = { ...readyPreview, state, pages: readyPreview.pages.map(({ screenshotPath: _ignored, ...page }) => page) };
    const view = render(<PresentationPagePicker title="deck.pptx" filePath="/tmp/deck.pptx" preview={preview} />);
    assertPositivePickerState(view.container, '经营数据');
    expect(view.container.textContent).toContain(message);
    expect(view.container.innerHTML).not.toContain('<img');
  });

  it('缺本地路径：组件、标题和大纲页先成立，再保持只读且不显示反馈入口', () => {
    const view = render(
      <PresentationPagePicker
        title="remote-deck.pptx"
        outlinePages={[{ index: 1, title: '远程封面', textPreview: '只读摘要' }]}
      />,
    );
    expect(view.container.innerHTML).toContain('data-testid="presentation-page-picker"');
    expect(view.container.textContent).toContain('远程封面');
    expect(view.container.querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
  });

  it('上传附件与 Workspace 点同一页，发出的结构化 locator anchor 完全相同', async () => {
    const attachment: MessageAttachment = {
      id: 'ppt-1',
      type: 'file',
      category: 'presentation',
      name: 'deck.pptx',
      size: 100,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      path: '/tmp/deck.pptx',
      pptJson: JSON.stringify({ format: 'pptx', slideCount: 2, slides: [{ index: 1, title: '蓝色封面' }, { index: 2, title: '经营数据' }] }),
    };
    const upload = render(<AttachmentDisplay attachments={[attachment]} />);
    await waitFor(() => expect(upload.container.textContent).toContain('经营数据'));
    const uploadAnchor = selectSecondPageAndSend();

    cleanup();
    sendPrompt.mockClear();
    const workspace = render(<PresentationPreview content={JSON.stringify(readyPreview)} />);
    assertPositivePickerState(workspace.container, '经营数据');
    const workspaceAnchor = selectSecondPageAndSend();

    expect(workspaceAnchor).toEqual(uploadAnchor);
    expect(workspaceAnchor).toEqual({
      localityAnchor: {
        kind: 'ppt-locator',
        filePath: '/tmp/deck.pptx',
        displayIndex: 1,
        relationshipId: 'rId2',
        slidePartName: 'ppt/slides/slide2.xml',
        textFingerprint: 'fp2',
        displayName: 'deck.pptx',
      },
    });
  });
});
