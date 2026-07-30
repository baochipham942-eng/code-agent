// ============================================================================
// SkillsSettings 信任门原地修复（批P 第六波①b）—— jsdom 交互链路
// 项目覆盖写 IPC 撞「目录未信任/失效」→ 错误条内联「确认信任」→ 既有 FolderTrustDialog
// （requireDangerousItems=false，零危险项也弹完整评估）→ set trusted → 自动重试 + 刷新。
// mock 风格对齐 projectSpace.test.tsx：invokeSkillIPC / ipcService 一律不进真 IPC；
// describeSkillIpcError / isSkillFolderTrustError 用真实实现（importOriginal），
// 让 classifier 在 UI 链路里也被真实走过。
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../src/renderer/services/invokeSkillIPC', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/services/invokeSkillIPC')>()),
  invokeSkillIPC: vi.fn(),
  invokeSkillIPCOrThrow: vi.fn(),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));

import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';
import type { InstalledSkill } from '../../../src/renderer/components/features/settings/tabs/SkillsInstalledTab';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { invokeSkillIPC, invokeSkillIPCOrThrow } from '../../../src/renderer/services/invokeSkillIPC';
import ipcService from '../../../src/renderer/services/ipcService';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const skillsText = zh.settings.skills.main;
const TRUST_ERROR_MESSAGE = '该目录未被信任，无法为其配置技能：/ws。先在该目录打开会话并信任此项目。';

const pdfSkill: InstalledSkill = {
  name: 'pdf',
  description: 'pdf desc',
  promptContent: '',
  basePath: '/u/pdf',
  allowedTools: [],
  disableModelInvocation: false,
  userInvocable: true,
  executionContext: 'inline',
  source: 'user',
  globalEnabled: true,
  projectOverride: null,
  enabled: true,
};

// 零危险项 + identityChanged：技能门恰在这种「信任失效」场景也拦，弹窗必须渲染完整评估
const trustEvaluation = {
  state: 'untrusted' as const,
  canonicalRealpath: '/ws',
  displayPath: '/ws',
  dangerousItems: [],
  blockedItems: [],
  identityChanged: true,
};

function mockInvokeDomain() {
  vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
    if (action === 'get') return trustEvaluation;
    if (action === 'set') return { ...trustEvaluation, state: 'trusted' as const };
    throw new Error(`unexpected action ${action}`);
  });
}

async function renderInstalledTab() {
  // settingsCapabilityFocus 深链让组件落到「已安装」tab（默认落「发现安装」）
  useAppStore.setState({
    settingsCapabilityFocus: { kind: 'skill', id: 'pdf', nonce: 1 },
  });
  render(<SkillsSettings />);
  return screen.findByLabelText('本项目内启停 pdf');
}

describe('SkillsSettings 目录信任门原地修复', () => {
  beforeEach(() => {
    vi.mocked(invokeSkillIPC).mockImplementation(async (channel) =>
      channel === SKILL_CHANNELS.SKILL_LIST ? [pdfSkill] : undefined,
    );
    vi.mocked(invokeSkillIPCOrThrow).mockResolvedValue(undefined);
    mockInvokeDomain();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({ settingsCapabilityFocus: null });
  });

  it('信任类错误 → 错误条内联「确认信任」按钮且不自动消失；非信任错误 → 无按钮', async () => {
    vi.mocked(invokeSkillIPCOrThrow).mockRejectedValueOnce(new Error(TRUST_ERROR_MESSAGE));
    const select = await renderInstalledTab();
    fireEvent.change(select, { target: { value: 'on' } });

    const trustButton = await screen.findByText(skillsText.confirmTrust);
    expect(screen.getByText(new RegExp(TRUST_ERROR_MESSAGE))).toBeTruthy();

    // 普通错误：错误条照常，但不出「确认信任」
    vi.mocked(invokeSkillIPCOrThrow).mockRejectedValueOnce(new Error('disk full'));
    fireEvent.change(select, { target: { value: 'follow' } });
    await screen.findByText(/disk full/);
    expect(screen.queryByText(skillsText.confirmTrust)).toBeNull();
    expect(trustButton).toBeTruthy();
  });

  it('确认信任 → 既有 FolderTrustDialog（零危险项也渲染）→ 授权成功自动重试并刷新', async () => {
    vi.mocked(invokeSkillIPCOrThrow)
      .mockRejectedValueOnce(new Error(TRUST_ERROR_MESSAGE))
      .mockResolvedValue(undefined);
    const select = await renderInstalledTab();
    fireEvent.change(select, { target: { value: 'on' } });

    // ① 点「确认信任」→ FOLDER_TRUST get → 弹完整 FolderTrustDialog
    fireEvent.click(await screen.findByText(skillsText.confirmTrust));
    await screen.findByText(zh.folderTrust.title);
    await waitFor(() =>
      expect(vi.mocked(ipcService.invokeDomain)).toHaveBeenCalledWith(IPC_DOMAINS.FOLDER_TRUST, 'get'),
    );
    // 零危险项：说明文案 + identityChanged 警告条在，危险项清单不在
    expect(screen.getByText(zh.folderTrust.emptyDangerNote)).toBeTruthy();
    expect(screen.getByText(zh.folderTrust.identityChanged)).toBeTruthy();
    expect(document.querySelector('[data-testid="folder-trust-danger-list"]')).toBeNull();

    // ② 弹窗内确认信任 → set trusted（decidedBy=skills-settings）
    fireEvent.click(screen.getByRole('button', { name: zh.folderTrust.trust }));
    await waitFor(() =>
      expect(vi.mocked(ipcService.invokeDomain)).toHaveBeenCalledWith(IPC_DOMAINS.FOLDER_TRUST, 'set', {
        state: 'trusted',
        decidedBy: 'skills-settings',
      }),
    );

    // ③ 自动重试：SKILL_PROJECT_SET 被再发一次（乐观更新重放），随后刷新技能列表
    await waitFor(() => {
      const calls = vi.mocked(invokeSkillIPCOrThrow).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([SKILL_CHANNELS.SKILL_PROJECT_SET, 'pdf', true]);
      expect(calls[1]).toEqual([SKILL_CHANNELS.SKILL_PROJECT_SET, 'pdf', true]);
    });
    await waitFor(() =>
      expect(
        vi.mocked(invokeSkillIPC).mock.calls.filter(([c]) => c === SKILL_CHANNELS.SKILL_LIST),
      ).toHaveLength(2),
    );
    // 错误条已清，弹窗已关
    expect(screen.queryByText(skillsText.confirmTrust)).toBeNull();
    expect(screen.queryByText(zh.folderTrust.title)).toBeNull();
  });

  it('follow（CLEAR）撞信任门同样出按钮，授权后重发 CLEAR', async () => {
    const overriddenSkill: InstalledSkill = { ...pdfSkill, projectOverride: true, enabled: true };
    vi.mocked(invokeSkillIPC).mockImplementation(async (channel) =>
      channel === SKILL_CHANNELS.SKILL_LIST ? [overriddenSkill] : undefined,
    );
    vi.mocked(invokeSkillIPCOrThrow)
      .mockRejectedValueOnce(new Error(TRUST_ERROR_MESSAGE))
      .mockResolvedValue(undefined);
    const select = await renderInstalledTab();
    fireEvent.change(select, { target: { value: 'follow' } });

    fireEvent.click(await screen.findByText(skillsText.confirmTrust));
    fireEvent.click(await screen.findByRole('button', { name: zh.folderTrust.trust }));

    await waitFor(() => {
      const calls = vi.mocked(invokeSkillIPCOrThrow).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual([SKILL_CHANNELS.SKILL_PROJECT_CLEAR, 'pdf']);
    });
  });
});
