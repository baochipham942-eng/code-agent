// @vitest-environment jsdom
// 冷启动 switchSession 会在 ?open= 摊开二级页之后 closeSecondaryPages。
// 钩子必须在会话 id 第一次变化时再摊开一次，且不能在之后的切换里把页面钉住。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('自动化深链在会话 id 第一次变化后重新打开，之后不再钉住', () => {
    window.history.pushState({}, '', '/?open=automation&cronTab=runs');
    render(<Probe />);
    expect(useAppStore.getState().showCronCenter).toBe(true);

    act(() => {
      closePages();
      useSessionStore.setState({ isLoading: true });
    });
    expect(useAppStore.getState().showCronCenter).toBe(false);

    act(() => {
      useSessionStore.setState({ currentSessionId: 'session-1' });
    });
    expect(useAppStore.getState().showCronCenter).toBe(true);

    act(() => {
      useAppStore.getState().setShowCronCenter(false);
      useSessionStore.setState({ currentSessionId: 'session-2' });
    });
    expect(useAppStore.getState().showCronCenter).toBe(false);
  });

  it('角色深链在同一次启动切换后回到该角色，再次切换不重开', () => {
    window.history.pushState({}, '', '/?open=role&roleId=ledger-role-a&roleTab=records');
    render(<Probe />);
    expect(useAppStore.getState().expertDetailRoleId).toBe('ledger-role-a');

    act(() => {
      closePages();
      useSessionStore.setState({ currentSessionId: 'session-1' });
    });
    expect(useAppStore.getState().expertDetailRoleId).toBe('ledger-role-a');

    act(() => {
      closePages();
      useSessionStore.setState({ currentSessionId: 'session-2' });
    });
    expect(useAppStore.getState().expertDetailRoleId).toBe(null);
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
