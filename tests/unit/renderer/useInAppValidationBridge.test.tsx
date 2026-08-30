// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// 捕获 bridge 注册的 IPC listener，测试里手动触发。
const captured: { listener: ((request: unknown) => void) | null } = { listener: null };

vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: {
    on: vi.fn((_channel: string, cb: (request: unknown) => void) => {
      captured.listener = cb;
      return () => {};
    }),
    invoke: vi.fn(async () => undefined),
  },
  default: {
    on: vi.fn(),
    invoke: vi.fn(async () => undefined),
  },
}));

import { useInAppValidationBridge } from '../../../src/renderer/hooks/useInAppValidationBridge';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const request = {
  requestId: 'req-1',
  html: '<!doctype html><html></html>',
  steps: [],
  timeoutMs: 5000,
};

function Probe(): null {
  useInAppValidationBridge();
  return null;
}

describe('useInAppValidationBridge（不抢占契约）', () => {
  beforeEach(() => {
    captured.listener = null;
    useAppStore.setState({
      showInAppValidation: false,
      pendingInAppValidationRequest: null,
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ showInAppValidation: false, pendingInAppValidationRequest: null });
  });

  it('验证面未打开：打开主干应用内验证工作台', () => {
    render(<Probe />);
    expect(captured.listener).toBeTypeOf('function');

    act(() => captured.listener?.(request));

    expect(useAppStore.getState()).toMatchObject({
      showInAppValidation: true,
      pendingInAppValidationRequest: request,
    });
  });

  it('验证面已打开：只更新 pending，不重复导航', () => {
    useAppStore.setState({ showInAppValidation: true });
    render(<Probe />);

    act(() => captured.listener?.(request));

    expect(useAppStore.getState()).toMatchObject({
      showInAppValidation: true,
      pendingInAppValidationRequest: request,
    });
  });
});
