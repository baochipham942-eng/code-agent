// @vitest-environment jsdom
// 冷启动会连切两次会话，第二次同 id 只关页。钩子在启动窗口内把页摊开，窗口过后不再钉住。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useLedgerDeepLink } from '../../../src/renderer/hooks/useLedgerDeepLink';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function Probe(): null {
  useLedgerDeepLink();
  return null;
}

function closePages(): void {
  useAppStore.getState().closeSecondaryPages();
}

describe('useLedgerDeepLink', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    closePages();
    useSessionStore.setState({ currentSessionId: null });
  });

  afterEach(() => {
    cleanup();
    window.history.pushState({}, '', '/');
    closePages();
    useSessionStore.setState({ currentSessionId: null });
  });

  it('App 挂上钩子（删掉调用则截图深链再次被启动切会话关掉）', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    expect(app).toMatch(/import\s*\{[^}]*\buseLedgerDeepLink\b[^}]*\}\s*from/);
    expect(app).toMatch(/\buseLedgerDeepLink\(\)/);
  });

  it('启动窗口内自动化页被关掉会再摊开，窗口过后保持关闭', () => {
    const start = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      window.history.pushState({}, '', '/?open=automation&cronTab=runs');
      render(<Probe />);
      expect(useAppStore.getState().showCronCenter).toBe(true);

      act(() => closePages());
      expect(useAppStore.getState().showCronCenter).toBe(true);

      act(() => closePages());
      expect(useAppStore.getState().showCronCenter).toBe(true);

      now.mockReturnValue(start + 8_001);
      act(() => closePages());
      expect(useAppStore.getState().showCronCenter).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it('启动窗口内角色页被关掉会回到该角色，窗口过后保持关闭', () => {
    const start = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      window.history.pushState({}, '', '/?open=role&roleId=ledger-role-a&roleTab=records');
      render(<Probe />);
      expect(useAppStore.getState().expertDetailRoleId).toBe('ledger-role-a');

      act(() => closePages());
      expect(useAppStore.getState().expertDetailRoleId).toBe('ledger-role-a');

      now.mockReturnValue(start + 8_001);
      act(() => closePages());
      expect(useAppStore.getState().expertDetailRoleId).toBe(null);
    } finally {
      now.mockRestore();
    }
  });

  it('没有 open 参数时不订阅、不打开', () => {
    window.history.pushState({}, '', '/');
    render(<Probe />);
    act(() => {
      useSessionStore.setState({ currentSessionId: 'session-1' });
    });
    expect(useAppStore.getState().showCronCenter).toBe(false);
    expect(useAppStore.getState().expertDetailRoleId).toBe(null);
  });

  it('角色深链缺少 roleId 时不打开', () => {
    window.history.pushState({}, '', '/?open=role');
    render(<Probe />);
    act(() => {
      useSessionStore.setState({ currentSessionId: 'session-1' });
    });
    expect(useAppStore.getState().expertDetailRoleId).toBe(null);
  });
});
