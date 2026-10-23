// ============================================================================
// SkillsSettings 外部导入深链落点（N-EXTHISTORY-IMPORT-K1A-FU2-FU1）：
// 「查看技能」经 openCapabilitySettingsTarget({source:'external-import'}) 深链进来 →
// 内层子 tab 落「已安装」、不渲染「来自会话页」横幅、落页即清焦
// （后续自然进入仍是默认「发现安装」，默认不回归 2026-07-27 拍板）。
// 用真实 appStore 走完整 store 链路；mock 风格对齐 skillsSettings.trustRetry.test.tsx。
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../src/renderer/services/invokeSkillIPC', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/services/invokeSkillIPC')>()),
  invokeSkillIPC: vi.fn().mockResolvedValue([]),
  invokeSkillIPCOrThrow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(), invoke: vi.fn().mockResolvedValue({ success: true, data: [] }) },
}));

import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';

const skillsText = zh.settings.skills.main;

describe('SkillsSettings 外部导入深链落点', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsCapabilityFocus: null, showCapabilityHub: false, showSettings: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({ settingsCapabilityFocus: null, showCapabilityHub: false, showSettings: false });
  });

  it('external-import 深链 → 已安装选中、无「来自会话页」横幅、落页即清焦', async () => {
    useAppStore.getState().openCapabilitySettingsTarget({ kind: 'skill', id: '', source: 'external-import' });
    const focusAfterOpen = useAppStore.getState().settingsCapabilityFocus;
    expect(focusAfterOpen?.kind).toBe('skill');
    expect(focusAfterOpen?.source).toBe('external-import');

    render(<SkillsSettings />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /已安装/ }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(screen.getByRole('tab', { name: '发现安装' }).getAttribute('aria-selected')).toBe('false');

    // 横幅前缀（id 为空时横幅文本恰为 prefix 本身）与「关闭提示」按钮都不在场
    expect(screen.queryByText(skillsText.focusPromptPrefix.trim())).toBeNull();
    expect(screen.queryByText(skillsText.closeFocusPrompt)).toBeNull();

    // 落页即清焦：深链消费完不留残余
    await waitFor(() => expect(useAppStore.getState().settingsCapabilityFocus).toBeNull());

    // 清焦后再自然进入（重新挂载）：默认「发现安装」不受深链影响
    cleanup();
    render(<SkillsSettings />);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '发现安装' }).getAttribute('aria-selected')).toBe('true'),
    );
  });

  it('无深链 → 默认「发现安装」（既有拍板不回归）', async () => {
    render(<SkillsSettings />);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '发现安装' }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(screen.getByRole('tab', { name: /已安装/ }).getAttribute('aria-selected')).toBe('false');
  });
});
