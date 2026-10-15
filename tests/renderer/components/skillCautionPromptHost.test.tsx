// @vitest-environment jsdom
// ============================================================================
// SkillCautionPromptHost 回归（N-SKILL-CAUTION-GATE-ON ②）：拖拽 ZIP /
// /plugins install 命中 caution 时必须弹设置页同款确认面，不允许静默装、
// 也不允许只报「安装失败」。这里把 App 级宿主真实挂起来，走真 divert /
// installExtensionWithSkillCautionConfirm，只桩 IPC 边界：
// - 拖拽确认 → 携 token 重发 + 挂载 + 成功提示
// - 拖拽取消 → 不重发、不挂载、不当附件回流（leftover 空）+「未安装」提示
// - slash 确认 → EXTENSION_INSTALL 携 token 重调；取消 → 按失败收口（reject）
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
const invokeSkillIPCOrThrow = vi.hoisted(() => vi.fn());
const invokeSkillIPC = vi.hoisted(() => vi.fn());
const ipcInvoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/invokeSkillIPC', () => ({
  invokeSkillIPCOrThrow: (...args: unknown[]) => invokeSkillIPCOrThrow(...args),
  invokeSkillIPC: (...args: unknown[]) => invokeSkillIPC(...args),
}));
vi.mock('../../../src/renderer/services/ipcService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/ipcService')>();
  return {
    ...actual,
    invoke: (...args: unknown[]) => ipcInvoke(...args),
  };
});

import { SkillCautionPromptHost } from '../../../src/renderer/components/SkillCautionPromptHost';
import { divertDroppedSkillZips } from '../../../src/renderer/services/skillLocalZip';
import { installExtensionWithSkillCautionConfirm } from '../../../src/renderer/services/skillCautionPrompt';

const cautionText = zh.settings.skills.caution;

const confirmationRequired = {
  success: false as const,
  code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED' as const,
  pluginSpec: 'demo@local-zip',
  sourceTrust: 'local-marketplace' as const,
  cautionHits: [{ file: 'demo/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' }],
  confirmationToken: 'token-1',
};

function dropArgs() {
  return {
    sessionId: 's1',
    successPrefix: 'ok ',
    failPrefix: 'fail ',
    confirmPrompt: 'Install {name}?',
  };
}

function localZipCalls() {
  return invokeSkillIPCOrThrow.mock.calls.filter(([channel]) => channel === SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP);
}

function mountCalls() {
  return invokeSkillIPC.mock.calls.filter(([channel]) => channel === SKILL_CHANNELS.SESSION_MOUNT);
}

describe('SkillCautionPromptHost（拖拽 ZIP 入口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeSkillIPC.mockResolvedValue(true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('confirmation-required 弹同款确认面；确认 → 携 token 重发 + 挂载 + 成功提示，不当附件回流', async () => {
    invokeSkillIPCOrThrow
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ success: true, skillName: 'demo', pluginSpec: 'demo@local-zip' });
    render(<SkillCautionPromptHost />);

    const zip = new File(['PK'], 'demo.zip', { type: 'application/zip' });
    const leftover = divertDroppedSkillZips([zip], dropArgs());

    // 确认面带命中打开（设置页同款弹窗），首发安装已经发生但未装上
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    expect(screen.getByText('demo@local-zip')).toBeTruthy();
    expect(screen.getByText('git_clean')).toBeTruthy();
    expect(localZipCalls()).toHaveLength(1);
    expect(mountCalls()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    expect(await leftover).toEqual([]);
    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull());
    // 重发必须原样带上 host 下发的 token
    expect(localZipCalls()[1]).toEqual([
      SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP,
      expect.objectContaining({ cautionConfirmationToken: 'token-1' }),
    ]);
    expect(mountCalls()).toEqual([[SKILL_CHANNELS.SESSION_MOUNT, 's1', 'demo', 'local-zip']]);
    expect(toast.success).toHaveBeenCalledWith('ok demo');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('取消 → 不重发、不挂载、不当附件回流，「未安装」提示', async () => {
    invokeSkillIPCOrThrow.mockResolvedValueOnce(confirmationRequired);
    render(<SkillCautionPromptHost />);

    const zip = new File(['PK'], 'demo.zip', { type: 'application/zip' });
    const leftover = divertDroppedSkillZips([zip], dropArgs());

    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));

    expect(await leftover).toEqual([]);
    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull());
    expect(localZipCalls()).toHaveLength(1);
    expect(mountCalls()).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith(`${cautionText.notInstalledPrefix}demo@local-zip`);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('确认后内容变化再次 confirmation-required → 用新命中重开同一弹窗', async () => {
    const changed = {
      ...confirmationRequired,
      cautionHits: [{ file: 'demo/SKILL.md', ruleId: 'history_clear', snippet: 'history -c' }],
      confirmationToken: 'token-2',
    };
    invokeSkillIPCOrThrow
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce({ success: true, skillName: 'demo', pluginSpec: 'demo@local-zip' });
    render(<SkillCautionPromptHost />);

    const zip = new File(['PK'], 'demo.zip', { type: 'application/zip' });
    const leftover = divertDroppedSkillZips([zip], dropArgs());

    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    // 二次确认面带新命中重开，token 也换成新一轮的
    expect(await screen.findByText('history_clear')).toBeTruthy();
    expect(screen.queryByText('git_clean')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    expect(await leftover).toEqual([]);
    expect(localZipCalls()[2]).toEqual([
      SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP,
      expect.objectContaining({ cautionConfirmationToken: 'token-2' }),
    ]);
    // 重开轮次的收尾在 supersede 之后异步推进，用 waitFor 等它落地
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ok demo'));
  });
});

describe('SkillCautionPromptHost（/plugins install 入口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('确认 → EXTENSION_INSTALL 携 token 重调，resolve 不抛', async () => {
    ipcInvoke
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ success: true });
    render(<SkillCautionPromptHost />);

    const install = installExtensionWithSkillCautionConfirm('demo@trusted');
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    await expect(install).resolves.toBeUndefined();
    expect(ipcInvoke.mock.calls).toEqual([
      [IPC_CHANNELS.EXTENSION_INSTALL, 'demo@trusted', undefined],
      [IPC_CHANNELS.EXTENSION_INSTALL, 'demo@trusted', 'token-1'],
    ]);
  });

  it('取消 → 不重调，按安装失败收口（reject），并给「未安装」提示', async () => {
    ipcInvoke.mockResolvedValueOnce(confirmationRequired);
    render(<SkillCautionPromptHost />);

    const install = installExtensionWithSkillCautionConfirm('demo@trusted');
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));

    await expect(install).rejects.toThrow('Skill install cancelled before confirmation');
    expect(ipcInvoke.mock.calls).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledWith(`${cautionText.notInstalledPrefix}demo@local-zip`);
  });

  it('普通安装失败（非确认门）→ 原样抛 host 的 error，不弹确认面', async () => {
    ipcInvoke.mockResolvedValueOnce({ success: false, error: 'install boom' });
    render(<SkillCautionPromptHost />);

    await expect(installExtensionWithSkillCautionConfirm('demo@trusted')).rejects.toThrow('install boom');
    expect(screen.queryByText(cautionText.title)).toBeNull();
  });
});
