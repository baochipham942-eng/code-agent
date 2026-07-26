// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// 执行器打桩：脏保护测试不真的跑交互脚本。
vi.mock('../../../src/renderer/utils/inAppValidationExecutor', () => ({
  runInAppInteractions: vi.fn(async () => []),
}));

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: { invoke: invokeMock, on: vi.fn() },
  default: { invoke: invokeMock, on: vi.fn() },
}));

import { InAppValidationWorkspace } from '../../../src/renderer/components/features/inAppValidation/InAppValidationWorkspace';
import { runInAppInteractions } from '../../../src/renderer/utils/inAppValidationExecutor';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_CHANNELS } from '@shared/ipc';
import type { BrowserInteractionStepResult } from '../../../src/shared/contract/browserInteraction';

const request = {
  requestId: 'req-dirty-1',
  html: '<!doctype html><html><body>ipc</body></html>',
  steps: [],
  timeoutMs: 5000,
};

function htmlTextarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelectorAll('textarea')[0] as HTMLTextAreaElement;
}

describe('InAppValidationWorkspace 脏保护', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useAppStore.setState({ pendingInAppValidationRequest: null });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ pendingInAppValidationRequest: null });
  });

  it('无手动编辑时 IPC 请求直接应用，不出现挂起横幅', () => {
    const { container } = render(<InAppValidationWorkspace />);

    act(() => useAppStore.getState().setPendingInAppValidationRequest(request));

    expect(screen.queryByTestId('in-app-validation-held-request')).toBeNull();
    expect(htmlTextarea(container).value).toBe(request.html);
  });

  it('手动编辑后 IPC 请求挂起：横幅出现且不覆盖编辑', () => {
    const { container } = render(<InAppValidationWorkspace />);
    fireEvent.change(htmlTextarea(container), { target: { value: '<html>user edits</html>' } });

    act(() => useAppStore.getState().setPendingInAppValidationRequest(request));

    expect(screen.getByTestId('in-app-validation-held-request')).toBeTruthy();
    expect(htmlTextarea(container).value).toBe('<html>user edits</html>');
  });

  it('选择「保留当前编辑」：回传 error 拒绝并清掉 pending', () => {
    const { container } = render(<InAppValidationWorkspace />);
    fireEvent.change(htmlTextarea(container), { target: { value: '<html>user edits</html>' } });
    act(() => useAppStore.getState().setPendingInAppValidationRequest(request));

    fireEvent.click(screen.getByText('保留当前编辑'));

    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.IN_APP_VALIDATION_RESULT,
      expect.objectContaining({ requestId: request.requestId, error: expect.any(String) }),
    );
    expect(useAppStore.getState().pendingInAppValidationRequest).toBeNull();
    expect(screen.queryByTestId('in-app-validation-held-request')).toBeNull();
    expect(htmlTextarea(container).value).toBe('<html>user edits</html>');
  });

  it('选择「加载新请求」：覆盖编辑并进入 IPC 流程', () => {
    const { container } = render(<InAppValidationWorkspace />);
    fireEvent.change(htmlTextarea(container), { target: { value: '<html>user edits</html>' } });
    act(() => useAppStore.getState().setPendingInAppValidationRequest(request));

    fireEvent.click(screen.getByText('加载新请求'));

    expect(screen.queryByTestId('in-app-validation-held-request')).toBeNull();
    expect(htmlTextarea(container).value).toBe(request.html);
    // 请求已接管（active），等 iframe ready 后自动跑
    expect(useAppStore.getState().pendingInAppValidationRequest).toEqual(request);
  });
});


describe('InAppValidationWorkspace 粗糙点收尾（2026-07-27）', () => {
  const executorMock = vi.mocked(runInAppInteractions);

  function stepsTextarea(): HTMLTextAreaElement {
    return screen.getByTestId('steps-editor-textarea') as HTMLTextAreaElement;
  }

  function primeIframeAndRun(container: HTMLElement) {
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    fireEvent.load(iframe as HTMLIFrameElement);
    fireEvent.click(screen.getByText('运行脚本'));
  }

  beforeEach(() => {
    invokeMock.mockClear();
    executorMock.mockReset();
    executorMock.mockImplementation(async () => []);
    useAppStore.setState({ pendingInAppValidationRequest: null });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ pendingInAppValidationRequest: null });
  });

  it('steps 编辑器带行号 gutter，失焦非法 JSON 即时报错，改回合法自动清除', () => {
    render(<InAppValidationWorkspace />);

    const gutter = screen.getByTestId('steps-editor-gutter');
    const lineCount = stepsTextarea().value.split('\n').length;
    expect(gutter.children.length).toBe(lineCount);

    fireEvent.change(stepsTextarea(), { target: { value: '[{"label":  broken' } });
    // 未失焦不报错
    expect(screen.queryByTestId('steps-editor-parse-error')).toBeNull();

    fireEvent.blur(stepsTextarea());
    expect(screen.getByTestId('steps-editor-parse-error')).toBeTruthy();

    fireEvent.change(stepsTextarea(), { target: { value: '[]' } });
    expect(screen.queryByTestId('steps-editor-parse-error')).toBeNull();
  });

  it('HTML 源 textarea 默认 12 行且可纵向拖拽', () => {
    const { container } = render(<InAppValidationWorkspace />);

    const textarea = htmlTextarea(container);
    expect(textarea.rows).toBe(12);
    expect(textarea.className).toContain('resize-y');
  });

  it('运行中「重载」按钮 disabled，跑完恢复', async () => {
    let resolveRun: ((value: BrowserInteractionStepResult[]) => void) | null = null;
    executorMock.mockImplementation(
      () => new Promise<BrowserInteractionStepResult[]>((resolve) => { resolveRun = resolve; }),
    );
    const { container } = render(<InAppValidationWorkspace />);

    const reloadButton = screen.getByText('重载').closest('button') as HTMLButtonElement;
    expect(reloadButton.disabled).toBe(false);

    primeIframeAndRun(container);
    await waitFor(() => expect(reloadButton.disabled).toBe(true));

    await act(async () => resolveRun?.([]));
    await waitFor(() => expect(reloadButton.disabled).toBe(false));
  });

  it('结果区有失败汇总头且失败卡片置顶，通过徽标走 i18n', async () => {
    const results: BrowserInteractionStepResult[] = [
      { label: 'passed-step', viewport: '', action: { type: 'click-selector', selector: '#a' }, passed: true, durationMs: 1, failures: [], checks: [] },
      { label: 'failed-step', viewport: '', action: { type: 'click-selector', selector: '#b' }, passed: false, durationMs: 2, failures: ['boom'], checks: [] },
    ];
    executorMock.mockImplementation(async () => results);
    const { container } = render(<InAppValidationWorkspace />);

    primeIframeAndRun(container);

    const summary = await screen.findByTestId('in-app-validation-result-summary');
    expect(summary.textContent).toContain('1/2 通过');
    expect(summary.textContent).toContain('1 个失败');

    const region = summary.parentElement as HTMLElement;
    const text = region.textContent ?? '';
    expect(text.indexOf('failed-step')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('failed-step')).toBeLessThan(text.indexOf('passed-step'));
  });
});
