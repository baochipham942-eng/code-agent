// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    ['libreoffice-missing', '正在后台准备像素预览组件'],
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

describe('PresentationPagePicker libreoffice-missing 有界自动重试', () => {
  const missingPreview: PresentationPagePreviewResult = {
    filePath: '/tmp/deck.pptx',
    state: 'libreoffice-missing',
    pages: readyPreview.pages.map(({ screenshotPath: _ignored, ...page }) => page),
  };

  function mockInvoke(...results: PresentationPagePreviewResult[]): void {
    Object.defineProperty(window, 'domainAPI', {
      configurable: true,
      value: { invoke: vi.fn() },
    });
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    // 逐个返回；耗尽后再被调用就抛错，便于断言「不该再发请求」
    for (const result of results) invoke.mockResolvedValueOnce({ success: true, data: result });
    invoke.mockRejectedValueOnce(new Error('unexpected extra previewPresentation call'));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('missing 且无失败码：自动重发预览请求，下一次 ready 即渲染页图并停止轮询', async () => {
    mockInvoke(missingPreview, readyPreview);
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    const view = render(<PresentationPagePicker title="deck.pptx" filePath="/tmp/deck.pptx" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('正在后台准备像素预览组件');
    expect(view.container.innerHTML).not.toContain('<img');

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(view.container.innerHTML).toContain('<img');
    expect(view.container.innerHTML).toContain('deck-2.jpg');
    expect(view.container.textContent).not.toContain('正在后台准备像素预览组件');

    // ready 之后不应再发请求（再推进全程节奏也不发）
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('missing 且带失败码：显示具体原因，不再自动轮询', async () => {
    mockInvoke({ ...missingPreview, error: 'LIBREOFFICE_RUNTIME_OFFLINE' });
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    const view = render(<PresentationPagePicker title="deck.pptx" filePath="/tmp/deck.pptx" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('连不上 LibreOffice 下载源');
    expect(view.container.textContent).not.toContain('正在后台准备像素预览组件');

    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('卸载后清理重试定时器，不再发请求', async () => {
    mockInvoke(missingPreview);
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    const view = render(<PresentationPagePicker title="deck.pptx" filePath="/tmp/deck.pptx" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('右栏路径（缓存 missing 结果作为 preview prop）：首屏不重发，按退避自动重试，ready 即渲染页图并停止', async () => {
    mockInvoke(readyPreview);
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    // 走真实右栏入口：PreviewPanel 把 previewPresentation 的 JSON 缓存成 tab
    // content，PresentationPreview 解析后作为 preview prop 传给 picker。
    const view = render(<PresentationPreview content={JSON.stringify(missingPreview)} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // 首屏用缓存结果，不立即重发请求
    expect(invoke).toHaveBeenCalledTimes(0);
    expect(view.container.textContent).toContain('正在后台准备像素预览组件');
    expect(view.container.innerHTML).not.toContain('<img');

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(view.container.innerHTML).toContain('<img');
    expect(view.container.innerHTML).toContain('deck-2.jpg');
    expect(view.container.textContent).not.toContain('正在后台准备像素预览组件');

    // ready 之后不应再发请求（再推进全程节奏也不发）
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('右栏路径（preview prop 为缓存 missing 结果）：父组件重渲染不得把重试已拿到的页图打回「准备中」', async () => {
    mockInvoke(readyPreview);
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    // PreviewPanel 每次渲染都会用（同一份）缓存 content 重新渲染 PresentationPreview；
    // 重试已成功后，这种纯重渲染不允许把展示重置回缓存的 missing。
    const view = render(<PresentationPreview content={JSON.stringify(missingPreview)} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(view.container.innerHTML).toContain('<img');

    const sameContent = JSON.stringify(missingPreview);
    view.rerender(<PresentationPreview content={sameContent} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(view.container.innerHTML).toContain('<img');
    expect(view.container.textContent).not.toContain('正在后台准备像素预览组件');

    // 纯重渲染也不应立刻多发请求
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('右栏路径（preview prop 带失败码）：显示具体原因，不自动轮询', async () => {
    mockInvoke();
    const invoke = (window.domainAPI as { invoke: ReturnType<typeof vi.fn> }).invoke;
    const view = render(
      <PresentationPagePicker
        title="deck.pptx"
        filePath="/tmp/deck.pptx"
        preview={{ ...missingPreview, error: 'LIBREOFFICE_RUNTIME_OFFLINE' }}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(invoke).toHaveBeenCalledTimes(0);
    expect(view.container.textContent).toContain('连不上 LibreOffice 下载源');
    expect(view.container.textContent).not.toContain('正在后台准备像素预览组件');
  });
});
