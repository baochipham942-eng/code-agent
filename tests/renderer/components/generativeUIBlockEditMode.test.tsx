// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

// PrismCodeBlock 走 lazy import，测试里不需要真高亮
vi.mock(
  '../../../src/renderer/components/features/chat/MessageBubble/PrismCodeBlock',
  () => ({ default: ({ code }: { code: string }) => <pre>{code}</pre> }),
);

import { GenerativeUIBlock } from '../../../src/renderer/components/features/chat/MessageBubble/GenerativeUIBlock';

const CODE = `<div id="wrap">
  <h1>季度复盘</h1>
  <button>导出</button>
  <script>document.title = 'x';</script>
</div>`;

function editToggle(): HTMLElement {
  return screen.getByTestId('generative-ui-edit-toggle');
}

describe('GenerativeUIBlock 预览/编辑两态', () => {
  it('默认预览态：只有预览 iframe，且它带 allow-scripts 不带同源', () => {
    render(<GenerativeUIBlock code={CODE} />);

    const preview = screen.getByTestId('generative-ui-preview-frame');
    expect(preview.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.queryByTestId('generative-ui-edit-frame')).toBeNull();
    expect(editToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('切到编辑态：换成编辑 iframe，同源但无脚本权限，且明示动效会静止', () => {
    render(<GenerativeUIBlock code={CODE} />);
    fireEvent.click(editToggle());

    const edit = screen.getByTestId('generative-ui-edit-frame');
    expect(edit.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(screen.queryByTestId('generative-ui-preview-frame')).toBeNull();
    expect(editToggle().getAttribute('aria-pressed')).toBe('true');

    // 副作用如实告知，不能悄悄降级
    expect(screen.getByText(zh.generativeUI.editHint)).toBeTruthy();
    // P1 未选中时给引导，不是空白
    expect(screen.getByText(zh.generativeUI.selectHint)).toBeTruthy();
  });

  it('编辑态的 srcdoc 里没有 script，预览态的有', () => {
    render(<GenerativeUIBlock code={CODE} />);
    const previewDoc = screen.getByTestId('generative-ui-preview-frame').getAttribute('srcdoc') ?? '';
    expect(previewDoc).toContain('<script');

    fireEvent.click(editToggle());
    const editDoc = screen.getByTestId('generative-ui-edit-frame').getAttribute('srcdoc') ?? '';
    expect(editDoc).not.toContain('<script');
    expect(editDoc).toContain('季度复盘');
  });

  it('点选 iframe 里的元素后，外层选中条显示该元素的标签与文案', () => {
    render(<GenerativeUIBlock code={CODE} />);
    fireEvent.click(editToggle());

    const frame = screen.getByTestId('generative-ui-edit-frame') as HTMLIFrameElement;
    // jsdom 不会为 srcdoc 自动跑完整加载流程，这里直接把文档写进去再触发 onLoad，
    // 走的仍是组件真实的 attachEditDocument 分支（同源读 contentDocument）。
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(frame.getAttribute('srcdoc') ?? '');
    doc.close();
    fireEvent.load(frame);

    // iframe 内的点击发生在 React 的事件边界之外，状态更新要显式 flush
    act(() => {
      doc.querySelector('h1')!.dispatchEvent(new (doc.defaultView!).MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });

    const bar = screen.getByTestId('generative-ui-selection-bar');
    expect(bar.textContent).toContain('<h1>');
    expect(bar.textContent).toContain('季度复盘');
  });

  it('退出编辑态会真的拆掉挂在 iframe 文档上的监听与高亮', () => {
    render(<GenerativeUIBlock code={CODE} />);
    fireEvent.click(editToggle());

    const frame = screen.getByTestId('generative-ui-edit-frame') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(frame.getAttribute('srcdoc') ?? '');
    doc.close();
    fireEvent.load(frame);

    const button = doc.querySelector('button')!;
    act(() => {
      button.dispatchEvent(new (doc.defaultView!).MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });
    expect(screen.getByTestId('generative-ui-selection-bar')).toBeTruthy();
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(true);
    expect(doc.querySelector('[data-code-agent-locality-style]')).not.toBeNull();

    fireEvent.click(editToggle());

    // 断言打在被操作的那份 document 上，而不是「选中条没渲染」——后者被 editing
    // 开关挡着，无论有没有真拆监听都会消失，是天然假绿。
    expect(button.hasAttribute('data-code-agent-locality-selected')).toBe(false);
    expect(doc.querySelector('[data-code-agent-locality-style]')).toBeNull();
    expect(screen.getByTestId('generative-ui-preview-frame')).toBeTruthy();
  });
});
