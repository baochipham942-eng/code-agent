// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type AuthEvent } from '../../../src/shared/ipc';
import { shouldShowSessionExpiredToast, SessionExpiredNotice } from '../../../src/renderer/components/SessionExpiredNotice';
import ipcService from '../../../src/renderer/services/ipcService';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';

describe('SessionExpiredNotice (2c/ADR-030)', () => {
  it('曾登录但 session 过期 → 提示', () => {
    const event: AuthEvent = { type: 'signed_out', sessionExpired: true };
    expect(shouldShowSessionExpiredToast(event)).toBe(true);
  });

  it('主动登出（无 sessionExpired）→ 不打扰', () => {
    expect(shouldShowSessionExpiredToast({ type: 'signed_out' })).toBe(false);
    expect(shouldShowSessionExpiredToast({ type: 'signed_out', sessionExpired: false })).toBe(false);
  });

  it('登录/刷新事件 → 不提示', () => {
    expect(shouldShowSessionExpiredToast({ type: 'signed_in', sessionExpired: true })).toBe(false);
    expect(shouldShowSessionExpiredToast({ type: 'token_refreshed' })).toBe(false);
  });
});

describe('SessionExpiredNotice 一次过期只提示一次', () => {
  let listener: ((event: AuthEvent) => void) | null = null;

  afterEach(() => {
    cleanup();
    listener = null;
    vi.restoreAllMocks();
    useToastStore.setState({ toasts: [] });
    useAuthStore.setState({ showAuthModal: false });
  });

  function mount(): void {
    listener = null;
    vi.spyOn(ipcService, 'on').mockImplementation((channel, callback) => {
      if (channel === IPC_CHANNELS.AUTH_EVENT) {
        listener = callback as (event: AuthEvent) => void;
      }
      return () => {};
    });
    useAppStore.setState({ language: 'zh' });
    useAuthStore.setState({ showAuthModal: false });
    useToastStore.setState({ toasts: [] });
    render(React.createElement(SessionExpiredNotice));
    act(() => {
      listener?.({ type: 'signed_in' });
    });
    useToastStore.setState({ toasts: [] });
  }

  function emit(event: AuthEvent): void {
    act(() => {
      listener?.(event);
    });
  }

  it('N 次相同的 signed_out+sessionExpired 只弹 1 次，signed_in 重新武装，打开登录框则不再弹', () => {
    mount();
    const expired: AuthEvent = { type: 'signed_out', sessionExpired: true };
    const attempts = 12;

    for (let i = 0; i < attempts; i += 1) emit(expired);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]?.type).toBe('warning');
    expect(useToastStore.getState().toasts[0]?.message).toBe(zh.common.sessionExpiredReconnect);

    emit({ type: 'signed_in' });
    emit(expired);
    expect(useToastStore.getState().toasts).toHaveLength(2);

    emit({ type: 'signed_in' });
    useAuthStore.setState({ showAuthModal: true });
    for (let i = 0; i < attempts; i += 1) emit(expired);
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });
});
