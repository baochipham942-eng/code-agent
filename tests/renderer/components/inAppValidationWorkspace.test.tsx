// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_CHANNELS } from '@shared/ipc';

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
