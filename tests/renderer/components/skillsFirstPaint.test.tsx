// @vitest-environment jsdom
// ============================================================================
// 技能 tab 首屏不被远端货架拖住（2026-07-27 真机实测：五路串行 → 首屏 ~2s 空转）
// ============================================================================
// 断言的是行为不是赋值：registry 这一路挂着不返回时，本地两路一回来页面就必须可用，
// 且货架区要自报「加载中」——不能让空货架冒充「没有内容」。
// ============================================================================

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (
    selector: (state: { settingsCapabilityFocus: null; clearSettingsCapabilityFocus: () => void }) => unknown,
  ) =>
    selector({
      settingsCapabilityFocus: null,
      clearSettingsCapabilityFocus: () => undefined,
    }),
}));

vi.mock('../../../src/renderer/services/invokeSkillIPC', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/services/invokeSkillIPC')>(
    '../../../src/renderer/services/invokeSkillIPC',
  );
  const shared = vi.fn();
  return {
    invokeSkillIPC: shared,
    invokeSkillIPCOrThrow: shared,
    describeSkillIpcError: actual.describeSkillIpcError,
  };
});

import { invokeSkillIPC } from '../../../src/renderer/services/invokeSkillIPC';
import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';

const mockInvoke = vi.mocked(invokeSkillIPC);

describe('技能 tab 首屏加载', () => {
  let resolveRegistry: (value: { items: never[] }) => void;

  beforeEach(() => {
    const registryPending = new Promise<{ items: never[] }>((resolve) => {
      resolveRegistry = resolve;
    });
    mockInvoke.mockImplementation(((channel: string) => {
      switch (channel) {
        case SKILL_CHANNELS.REPO_LIST:
        case SKILL_CHANNELS.SKILL_LIST:
        case SKILL_CHANNELS.RECOMMENDED_REPOS:
          return Promise.resolve([]);
        case SKILL_CHANNELS.CATALOG:
          return Promise.resolve(undefined);
        case SKILL_CHANNELS.REGISTRY_LIST:
          return registryPending;
        default:
          return Promise.resolve(undefined);
      }
    }) as typeof invokeSkillIPC);
  });

  afterEach(() => {
    resolveRegistry({ items: [] });
    cleanup();
    vi.clearAllMocks();
  });

  it('registry 未返回时页面已经可用，货架区显示加载中而不是空货架', async () => {
    render(<SkillsSettings />);

    // 本地两路一回来首屏就解锁（刷新按钮只在 loading=false 后渲染）
    await screen.findByRole('button', { name: new RegExp(zh.settings.skills.main.refresh) });
    // 此刻 registry 仍挂着：货架区自报加载中
    expect(screen.getAllByText(zh.common.loading).length).toBeGreaterThan(0);

    resolveRegistry({ items: [] });
    // 货架返回空且无错误码时，加载态收掉
    await waitFor(() => expect(screen.queryByText(zh.common.loading)).toBeNull());
  });

  it('五路并发发起，不是串行等前一路', async () => {
    render(<SkillsSettings />);
    await waitFor(() => {
      const channels = mockInvoke.mock.calls.map(([channel]) => channel);
      expect(channels).toContain(SKILL_CHANNELS.REPO_LIST);
      expect(channels).toContain(SKILL_CHANNELS.REGISTRY_LIST);
      expect(channels).toContain(SKILL_CHANNELS.CATALOG);
    });
    // registry 挂着时，其余四路已经全部发出（串行实现会卡在 registry 之前）
    expect(mockInvoke.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});
