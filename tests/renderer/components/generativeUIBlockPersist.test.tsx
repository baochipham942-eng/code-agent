// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { hashGenerativeUiBody } from '../../../src/shared/generativeUIEdit';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock(
  '../../../src/renderer/components/features/chat/MessageBubble/PrismCodeBlock',
  () => ({ default: ({ code }: { code: string }) => <pre>{code}</pre> }),
);

const persistHtmlEdit = vi.fn();
vi.mock('../../../src/renderer/services/generativeUIClient', () => ({
  generativeUIClient: { persistHtmlEdit: (...args: unknown[]) => persistHtmlEdit(...args) },
}));

import { GenerativeUIBlock } from '../../../src/renderer/components/features/chat/MessageBubble/GenerativeUIBlock';

const CODE = '<div id="wrap"><h1>季度复盘</h1></div>';

function renderBlock(extra: Record<string, unknown> = {}) {
  return render(
    <GenerativeUIBlock code={CODE} messageId="msg-1" sessionId="sess-1" sourceOrdinal={0} {...extra} />,
  );
}

function toggle(): HTMLElement {
  return screen.getByTestId('generative-ui-edit-toggle');
}

function selectAndEditText(newText: string): void {
  fireEvent.click(toggle());
  const frame = screen.getByTestId('generative-ui-edit-frame') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(frame.getAttribute('srcdoc') ?? '');
  doc.close();
  fireEvent.load(frame);
  act(() => {
    doc.querySelector('h1')!.dispatchEvent(new (doc.defaultView!).MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0,
    }));
  });
  fireEvent.change(screen.getByTestId('generative-ui-text-input'), { target: { value: newText } });
}

beforeEach(() => {
  persistHtmlEdit.mockReset();
  persistHtmlEdit.mockResolvedValue({ persisted: true });
});

describe('退出编辑时把改动落库', () => {
  it('用 editBaseCode 的哈希对账，送出改过的 newCode 和动过的 fields', async () => {
    renderBlock();
    selectAndEditText('Q3 复盘');
    fireEvent.click(toggle()); // 退出编辑

    await waitFor(() => expect(persistHtmlEdit).toHaveBeenCalledTimes(1));
    const req = persistHtmlEdit.mock.calls[0][0];
    expect(req.sessionId).toBe('sess-1');
    expect(req.messageId).toBe('msg-1');
    expect(req.sourceOrdinal).toBe(0);
    // 对账基准是用户开始编辑时那份（未改的 CODE）
    expect(req.baseHash).toBe(hashGenerativeUiBody(CODE));
    expect(req.newCode).toContain('Q3 复盘');
    expect(req.fields).toContain('text');
  });

  it('没改动就退出，不打扰后端', () => {
    renderBlock();
    fireEvent.click(toggle()); // 进
    fireEvent.click(toggle()); // 出，什么都没改
    expect(persistHtmlEdit).not.toHaveBeenCalled();
  });

  it('切到「源码」视图前也会先落库，不静默丢改动', async () => {
    renderBlock();
    selectAndEditText('Q3 复盘');
    fireEvent.click(screen.getByText(zh.generativeUI.source));
    await waitFor(() => expect(persistHtmlEdit).toHaveBeenCalledTimes(1));
  });

  it('没有 messageId/sessionId 时本地可编辑但不落库（web 预览不回归）', () => {
    render(<GenerativeUIBlock code={CODE} />);
    fireEvent.click(toggle());
    const frame = screen.getByTestId('generative-ui-edit-frame') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.open(); doc.write(frame.getAttribute('srcdoc') ?? ''); doc.close();
    fireEvent.load(frame);
    act(() => {
      doc.querySelector('h1')!.dispatchEvent(new (doc.defaultView!).MouseEvent('click', {
        bubbles: true, cancelable: true, button: 0,
      }));
    });
    fireEvent.change(screen.getByTestId('generative-ui-text-input'), { target: { value: '改了' } });
    fireEvent.click(toggle());
    expect(persistHtmlEdit).not.toHaveBeenCalled();
  });
});

describe('冲突与流式', () => {
  it('后端报 conflict 时弹提示条', async () => {
    persistHtmlEdit.mockResolvedValue({ persisted: false, reason: 'conflict' });
    renderBlock();
    selectAndEditText('Q3 复盘');
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByTestId('generative-ui-conflict')).toBeTruthy());
    expect(screen.getByText(zh.generativeUI.editConflict)).toBeTruthy();
  });

  it('流式生成中禁止进入编辑', () => {
    renderBlock({ isStreaming: true });
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle());
    expect(screen.queryByTestId('generative-ui-edit-frame')).toBeNull();
  });
});
