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
      showEvalCenter: false,
      evalCenterTab: 'replay',
      pendingInAppValidationRequest: null,
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ showEvalCenter: false, pendingInAppValidationRequest: null });
  });

  it('评测中心未打开：打开评测中心并落到验证 tab', () => {
    render(<Probe />);
    expect(captured.listener).toBeTypeOf('function');

    act(() => captured.listener?.(request));

    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: true,
      evalCenterTab: 'validation',
      pendingInAppValidationRequest: request,
    });
  });

  it('评测中心已打开：只写 pending，不打断用户当前 tab', () => {
    useAppStore.setState({ showEvalCenter: true, evalCenterTab: 'replay' });
    render(<Probe />);

    act(() => captured.listener?.(request));

    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: true,
      // 仍是 replay tab —— 由 EvalCenterPage 的角标提示新请求
      evalCenterTab: 'replay',
      pendingInAppValidationRequest: request,
    });
  });
});
