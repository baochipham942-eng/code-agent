// @vitest-environment jsdom
// SoulSettings 提示词管理入口测试（2026-07-27 拍板：入口从能力中心 header 迁到设置页 → 人格 tab）。
// admin 看得到入口且点击后 showPromptManager 置 true；非 admin 整块不渲染。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { SoulSettings } from '../../../src/renderer/components/features/settings/tabs/SoulSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const user = (isAdmin: boolean) => ({ id: 'u1', email: 'u@example.com', isAdmin });

beforeEach(() => {
  invokeDomainMock.mockReset();
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'getStatus') return Promise.resolve({ source: 'builtin', length: 0 });
    if (action === 'getProfile') return Promise.resolve({ content: '', filePath: '/tmp/soul.md' });
    if (action === 'getDefault') return Promise.resolve({ content: 'default soul' });
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  useAppStore.setState({ showPromptManager: false });
});

describe('SoulSettings 提示词管理入口', () => {
  it('admin 看得到入口，点击后 showPromptManager 为 true', async () => {
    useAuthStore.setState({ user: user(true) });
    render(<SoulSettings />);
    // 等加载完（编辑器出现）再断言入口
    await screen.findByRole('textbox');

    const entry = screen.getByTestId('settings-open-prompt-manager');
    expect(useAppStore.getState().showPromptManager).toBe(false);
    fireEvent.click(entry);
    expect(useAppStore.getState().showPromptManager).toBe(true);
  });

  it('非 admin 完全看不到入口', async () => {
    useAuthStore.setState({ user: user(false) });
    render(<SoulSettings />);
    await screen.findByRole('textbox');

    expect(screen.queryByTestId('settings-open-prompt-manager')).toBeNull();
  });
});
