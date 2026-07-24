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

/** 进编辑态、把文档写进 iframe、点中某个元素，返回那份 document。 */
function enterEditAndSelect(cssSelector: string): { doc: Document; element: HTMLElement } {
  fireEvent.click(editToggle());
  const frame = screen.getByTestId('generative-ui-edit-frame') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(frame.getAttribute('srcdoc') ?? '');
  doc.close();
  fireEvent.load(frame);

  const element = doc.querySelector(cssSelector) as HTMLElement;
  act(() => {
    element.dispatchEvent(new (doc.defaultView!).MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
  });
  return { doc, element };
}

function previewSrcdoc(): string {
  return screen.getByTestId('generative-ui-preview-frame').getAttribute('srcdoc') ?? '';
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
    // 文案现在落在可编辑输入框里，不再是只读文本
    expect(screen.getByTestId<HTMLInputElement>('generative-ui-text-input').value)
      .toBe('季度复盘');
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

describe('属性面板改文字 / 字号 / 颜色', () => {
  it('改文字：iframe 里当场变，源码也跟着变（不是只改了 DOM）', () => {
    render(<GenerativeUIBlock code={CODE} />);
    const { element } = enterEditAndSelect('h1');

    fireEvent.change(screen.getByTestId('generative-ui-text-input'), {
      target: { value: 'Q3 复盘' },
    });

    // 所见即所得：活元素当场变
    expect(element.textContent).toBe('Q3 复盘');

    // 关键：源码也变了。只改 DOM 的话退出编辑态就打回原形。
    fireEvent.click(editToggle());
    expect(previewSrcdoc()).toContain('Q3 复盘');
    expect(previewSrcdoc()).not.toContain('季度复盘');
  });

  it('改字号与颜色：活元素落到内联 style，源码同步落', () => {
    render(<GenerativeUIBlock code={CODE} />);
    const { element } = enterEditAndSelect('h1');

    fireEvent.change(screen.getByTestId('generative-ui-font-size-input'), {
      target: { value: '28' },
    });
    fireEvent.change(screen.getByTestId('generative-ui-color-input'), {
      target: { value: '#2563eb' },
    });

    expect(element.style.fontSize).toBe('28px');
    expect(element.style.color).toBe('rgb(37, 99, 235)');

    fireEvent.click(editToggle());
    const srcdoc = previewSrcdoc();
    expect(srcdoc).toContain('font-size: 28px');
    expect(srcdoc).toContain('color: rgb(37, 99, 235)');
  });

  it('字号超出范围会被夹住，不会写出 0px 或 999px', () => {
    render(<GenerativeUIBlock code={CODE} />);
    const { element } = enterEditAndSelect('h1');

    fireEvent.change(screen.getByTestId('generative-ui-font-size-input'), {
      target: { value: '999' },
    });
    expect(element.style.fontSize).toBe('72px');

    fireEvent.change(screen.getByTestId('generative-ui-font-size-input'), {
      target: { value: '1' },
    });
    expect(element.style.fontSize).toBe('12px');
  });

  it('选中含子元素的块时不给改文字，只给字号颜色', () => {
    render(<GenerativeUIBlock code={CODE} />);
    enterEditAndSelect('#wrap');

    expect(screen.queryByTestId('generative-ui-text-input')).toBeNull();
    expect(screen.getByText(zh.generativeUI.textNotEditable)).toBeTruthy();
    expect(screen.getByTestId('generative-ui-font-size-input')).toBeTruthy();
  });

  it('改过之后「源码」看到的是改过的版本，不是模型的原稿', () => {
    render(<GenerativeUIBlock code={CODE} />);
    enterEditAndSelect('h1');
    fireEvent.change(screen.getByTestId('generative-ui-text-input'), {
      target: { value: 'Q3 复盘' },
    });

    fireEvent.click(screen.getByText(zh.generativeUI.source));
    expect(screen.getByText(/Q3 复盘/)).toBeTruthy();
  });

  it('外部 code 变了（模型重新生成）会清掉选中，不会拿旧选择器往新源码上打补丁', () => {
    const { rerender } = render(<GenerativeUIBlock code={CODE} />);
    enterEditAndSelect('h1');
    expect(screen.getByTestId('generative-ui-selection-bar')).toBeTruthy();

    rerender(<GenerativeUIBlock code={'<section><p>换了一份完全不同的产物</p></section>'} />);
    expect(screen.queryByTestId('generative-ui-selection-bar')).toBeNull();
  });
});

describe('导出为 .html 文件', () => {
  it('点导出触发一次带 .html 文件名的下载，内容是独立页面', () => {
    const createURL = vi.fn((_blob: Blob) => 'blob:xyz');
    const revokeURL = vi.fn();
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeURL as unknown as typeof URL.revokeObjectURL;
    const clicked: HTMLAnchorElement[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicked.push(this); };

    try {
      render(<GenerativeUIBlock code={'<html><head><title>季度复盘</title></head><body><h1>图</h1></body></html>'} />);
      fireEvent.click(screen.getByTestId('generative-ui-export'));

      expect(clicked).toHaveLength(1);
      expect(clicked[0].download).toMatch(/^季度复盘_\d{4}-\d{2}-\d{2}\.html$/);
      // Blob 用独立页面构建，不含 iframe 专用注入
      const blob = createURL.mock.calls[0]![0];
      expect(blob.type).toContain('text/html');
      expect(revokeURL).toHaveBeenCalled();
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      HTMLAnchorElement.prototype.click = origClick;
    }
  });

  it('导出的是用户改过的版本，不是模型原稿', () => {
    // jsdom 的 Blob.text() 未实现，改成 spy 构造函数拿到原始字符串
    const parts: string[] = [];
    const RealBlob = globalThis.Blob;
    class SpyBlob extends RealBlob {
      constructor(bits: BlobPart[], opts?: BlobPropertyBag) {
        super(bits, opts);
        parts.push(bits.map(String).join(''));
      }
    }
    globalThis.Blob = SpyBlob as unknown as typeof Blob;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => 'blob:xyz') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as unknown as typeof URL.revokeObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};

    try {
      render(<GenerativeUIBlock code={CODE} />);
      enterEditAndSelect('h1');
      fireEvent.change(screen.getByTestId('generative-ui-text-input'), { target: { value: 'Q3 复盘' } });
      fireEvent.click(editToggle()); // 退出编辑

      fireEvent.click(screen.getByTestId('generative-ui-export'));
      const exported = parts.at(-1)!;
      expect(exported).toContain('Q3 复盘');
      expect(exported).not.toContain('季度复盘');
    } finally {
      globalThis.Blob = RealBlob;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      HTMLAnchorElement.prototype.click = origClick;
    }
  });
});
