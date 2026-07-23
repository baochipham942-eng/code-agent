// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, type PreviewTab } from '../../../src/renderer/stores/appStore';

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

import {
  PreviewPanel,
  StaticHtmlPreview,
} from '../../../src/renderer/components/PreviewPanel';

function clickInIframe(element: Element): MouseEvent {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error('iframe document has no window');
  const event = new view.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  element.dispatchEvent(event);
  return event;
}

async function waitForIframeLoad(iframe: HTMLIFrameElement): Promise<void> {
  await new Promise<void>((resolve) => {
    iframe.addEventListener('load', () => resolve(), { once: true });
  });
}

function loadedTab(overrides: Partial<PreviewTab>): PreviewTab {
  return {
    id: 'preview-test',
    path: '/tmp/prototype.html',
    content: '<button>开始规划行程</button>',
    savedContent: '<button>开始规划行程</button>',
    mode: 'preview',
    lastActivatedAt: 1,
    isLoaded: true,
    kind: 'file',
    ...overrides,
  };
}

beforeEach(() => {
  sendPrompt.mockClear();
  useAppStore.setState({
    previewTabs: [],
    activePreviewTabId: null,
    language: 'zh',
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ previewTabs: [], activePreviewTabId: null });
});

describe('StaticHtmlPreview 圈选与反馈', () => {
  it('圈选模式默认关闭时，点击预览内的可点击元素不会被 preventDefault', async () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    render(
      <StaticHtmlPreview
        html="<button>继续</button>"
        filePath="/tmp/prototype.html"
        iframeRef={iframeRef}
        title="HTML 预览"
      />,
    );

    const iframe = iframeRef.current!;
    await waitForIframeLoad(iframe);
    const iframeDoc = iframe.contentDocument!;
    iframeDoc.body.innerHTML = '<button>继续</button>';
    const button = iframeDoc.querySelector('button')!;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);

    let event: MouseEvent;
    act(() => {
      event = clickInIframe(button);
    });

    expect(event!.defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(false);
    expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
  });

  it('真实点击元素后显示反馈栏，发送的 anchor 可定位且成功后清空选中', async () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    render(
      <StaticHtmlPreview
        html="<main><button>开始规划行程</button></main>"
        filePath="/tmp/travel/prototype.html"
        iframeRef={iframeRef}
        title="HTML 预览"
      />,
    );

    const iframe = iframeRef.current;
    expect(iframe).not.toBeNull();
    await waitForIframeLoad(iframe!);
    const iframeDoc = iframe!.contentDocument!;
    iframeDoc.body.innerHTML = '<main><button>开始规划行程</button></main>';

    fireEvent.click(screen.getByRole('button', { name: '圈选' }));
    const button = iframeDoc.querySelector('button')!;
    act(() => clickInIframe(button));

    const input = await screen.findByPlaceholderText('这里改成…（回车发送）');
    expect(screen.getByText(/<button> 开始规划行程/)).not.toBeNull();
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(true);

    fireEvent.change(input, { target: { value: '改成蓝色主按钮' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    const [message, context] = sendPrompt.mock.calls[0];
    expect(message).toContain('/tmp/travel/prototype.html');
    expect(message).toContain(context.localityAnchor.selector);
    expect(iframeDoc.querySelector(context.localityAnchor.selector)).toBe(button);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
    });
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(false);
  });

  it('srcdoc 更新时立即清掉旧反馈栏和旧 document 的节点引用', async () => {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    const { rerender } = render(
      <StaticHtmlPreview
        html="<button>旧按钮</button>"
        filePath="/tmp/prototype.html"
        iframeRef={iframeRef}
        title="HTML 预览"
      />,
    );
    const iframe = iframeRef.current!;
    await waitForIframeLoad(iframe);
    const iframeDoc = iframe.contentDocument!;
    iframeDoc.body.innerHTML = '<button>旧按钮</button>';
    fireEvent.click(screen.getByRole('button', { name: '圈选' }));
    const oldButton = iframeDoc.querySelector('button')!;
    act(() => clickInIframe(oldButton));
    expect(await screen.findByPlaceholderText('这里改成…（回车发送）')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '圈选' }));
    expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
    expect(oldButton.hasAttribute('data-code-agent-locality-selected')).toBe(false);
    let modeOffClick: MouseEvent;
    act(() => {
      modeOffClick = clickInIframe(oldButton);
    });
    expect(modeOffClick!.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '圈选' }));
    act(() => clickInIframe(oldButton));
    expect(await screen.findByPlaceholderText('这里改成…（回车发送）')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '取消选中' }));
    expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
    expect(oldButton.hasAttribute('data-code-agent-locality-selected')).toBe(false);

    act(() => clickInIframe(oldButton));
    expect(await screen.findByPlaceholderText('这里改成…（回车发送）')).not.toBeNull();

    rerender(
      <StaticHtmlPreview
        html="<button>新按钮</button>"
        filePath="/tmp/prototype.html"
        iframeRef={iframeRef}
        title="HTML 预览"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
    });
    expect(oldButton.hasAttribute('data-code-agent-locality-selected')).toBe(false);
  });
});

describe('PreviewPanel 非 HTML 分支', () => {
  it('有真实图片 tab 时渲染图片，不挂 srcdoc 选择面或反馈栏', () => {
    const tab = loadedTab({
      path: '/tmp/cover.png',
      content: 'data:image/png;base64,AA==',
      savedContent: 'data:image/png;base64,AA==',
    });
    useAppStore.setState({
      previewTabs: [tab],
      activePreviewTabId: tab.id,
    });

    const { container } = render(<PreviewPanel />);

    expect(container.querySelector('img[alt="/tmp/cover.png"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="static-html-preview"]')).toBeNull();
    expect(screen.queryByPlaceholderText('这里改成…（回车发送）')).toBeNull();
  });
});
