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
    expect(screen.getByText(cautionText.rules.git_clean)).toBeTruthy();
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
    expect(await screen.findByText(cautionText.rules.history_clear)).toBeTruthy();
    expect(screen.queryByText(cautionText.rules.git_clean)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    expect(await leftover).toEqual([]);
    expect(localZipCalls()[2]).toEqual([
      SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP,
      expect.objectContaining({ cautionConfirmationToken: 'token-2' }),
    ]);
    // 重开轮次的收尾在 supersede 之后异步推进，用 waitFor 等它落地
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ok demo'));
  });

  it('第二次拖入顶掉未确认完的第一次：第一个 zip 未安装、按附件回流（leftover），第二个正常装', async () => {
    const reqA = { ...confirmationRequired, pluginSpec: 'a-skill@local-zip', confirmationToken: 'token-a' };
    const reqB = { ...confirmationRequired, pluginSpec: 'b-skill@local-zip', confirmationToken: 'token-b' };
    invokeSkillIPCOrThrow.mockImplementation(async (_channel, payload) => {
      if (payload.cautionConfirmationToken === 'token-b') {
        return { success: true, skillName: 'b-skill', pluginSpec: 'b-skill@local-zip' };
      }
      return payload.archiveBase64 === 'Qg==' ? reqB : reqA;
    });
    render(<SkillCautionPromptHost />);

    const zipA = new File(['A'], 'a.zip', { type: 'application/zip' });
    const zipB = new File(['B'], 'b.zip', { type: 'application/zip' });
    const leftoverA = divertDroppedSkillZips([zipA], dropArgs());
    expect(await screen.findByText('a-skill@local-zip')).toBeTruthy();

    // 第二次拖入顶掉还没确认完的第一次：弹窗换内容，A 未装不当已安装
    const leftoverB = divertDroppedSkillZips([zipB], dropArgs());
    expect(await screen.findByText('b-skill@local-zip')).toBeTruthy();
    expect(await leftoverA).toEqual([zipA]);

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    expect(await leftoverB).toEqual([]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ok b-skill'));
    // A 的安装通道只到过首发，从未带 token 重发；B 携 token 重发并挂载
    const aCalls = localZipCalls().filter(([, payload]) => payload.archiveBase64 === 'QQ==');
    expect(aCalls).toHaveLength(1);
    expect(mountCalls()).toEqual([[SKILL_CHANNELS.SESSION_MOUNT, 's1', 'b-skill', 'local-zip']]);
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

  it('二次 confirmation-required：第二次确认前不得 resolve（第一次确认≠已安装），二次确认后才收尾', async () => {
    const changed = {
      ...confirmationRequired,
      cautionHits: [{ file: 'demo/SKILL.md', ruleId: 'history_clear', snippet: 'history -c' }],
      confirmationToken: 'token-2',
    };
    ipcInvoke
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce({ success: true });
    render(<SkillCautionPromptHost />);

    const install = installExtensionWithSkillCautionConfirm('demo@trusted');
    let outcome: 'resolved' | 'rejected' | undefined;
    void install.then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    // 二次确认面已带新命中重开，但流程没走到终态——命令层不得提前看到 Installed
    expect(await screen.findByText(cautionText.rules.history_clear)).toBeTruthy();
    expect(outcome).toBeUndefined();
    expect(ipcInvoke.mock.calls).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    await expect(install).resolves.toBeUndefined();
    expect(ipcInvoke.mock.calls[2]).toEqual([IPC_CHANNELS.EXTENSION_INSTALL, 'demo@trusted', 'token-2']);
  });

  it('二次 confirmation-required 后取消 → 按安装失败收口（reject），不当已安装', async () => {
    const changed = {
      ...confirmationRequired,
      cautionHits: [{ file: 'demo/SKILL.md', ruleId: 'history_clear', snippet: 'history -c' }],
      confirmationToken: 'token-2',
    };
    ipcInvoke
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce(changed);
    render(<SkillCautionPromptHost />);

    const install = installExtensionWithSkillCautionConfirm('demo@trusted');
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    expect(await screen.findByText(cautionText.rules.history_clear)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));
    await expect(install).rejects.toThrow('Skill install cancelled before confirmation');
    // 只有首发 + 一次携 token 重发，安装没有第三跳
    expect(ipcInvoke.mock.calls).toHaveLength(2);
  });

  it('新安装顶掉未确认完的旧安装：旧流程按未安装收口（reject），且从未被 token 重调', async () => {
    const reqA = { ...confirmationRequired, pluginSpec: 'a-skill@local-zip', confirmationToken: 'token-a' };
    const reqB = { ...confirmationRequired, pluginSpec: 'b-skill@local-zip', confirmationToken: 'token-b' };
    ipcInvoke.mockImplementation(async (_channel, spec, token) => {
      if (token) return { success: true };
      return spec === 'a@market' ? reqA : reqB;
    });
    render(<SkillCautionPromptHost />);

    const installA = installExtensionWithSkillCautionConfirm('a@market');
    // 先挂上 rejection 断言：A 的结算发生在 B 开窗的同一拍，晚了会变 unhandled
    const installARejected = expect(installA).rejects.toThrow('Skill install cancelled before confirmation');
    expect(await screen.findByText('a-skill@local-zip')).toBeTruthy();

    // B 顶掉还没确认完的 A：弹窗换内容，A 按未安装收口（不是当成已装完）
    const installB = installExtensionWithSkillCautionConfirm('b@market');
    expect(await screen.findByText('b-skill@local-zip')).toBeTruthy();
    await installARejected;

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    await expect(installB).resolves.toBeUndefined();
    expect(ipcInvoke.mock.calls.filter(([, spec]) => spec === 'a@market')).toHaveLength(1);
    expect(ipcInvoke.mock.calls.filter(([, spec]) => spec === 'b@market')).toEqual([
      [IPC_CHANNELS.EXTENSION_INSTALL, 'b@market', undefined],
      [IPC_CHANNELS.EXTENSION_INSTALL, 'b@market', 'token-b'],
    ]);
  });

  it('被顶掉流程迟到的二次 confirmation-required 不得抢走活流程的确认窗', async () => {
    const reqA = { ...confirmationRequired, pluginSpec: 'a-skill@local-zip', confirmationToken: 'token-a' };
    const reqA2 = {
      ...reqA,
      cautionHits: [{ file: 'a/SKILL.md', ruleId: 'history_clear', snippet: 'history -c' }],
    };
    const reqB = { ...confirmationRequired, pluginSpec: 'b-skill@local-zip', confirmationToken: 'token-b' };
    let landA2: (value: typeof reqA2) => void = () => {};
    const a2Pending = new Promise<typeof reqA2>((resolve) => { landA2 = resolve; });
    ipcInvoke.mockImplementation(async (_channel, spec, token) => {
      if (spec === 'a@market') return token ? a2Pending : reqA;
      return token ? { success: true } : reqB;
    });
    render(<SkillCautionPromptHost />);

    const installA = installExtensionWithSkillCautionConfirm('a@market');
    const installARejected = expect(installA).rejects.toThrow('Skill install cancelled before confirmation');
    expect(await screen.findByText('a-skill@local-zip')).toBeTruthy();
    // A 的确认重发挂在途（busy），此时 B 顶掉 A
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    const installB = installExtensionWithSkillCautionConfirm('b@market');
    expect(await screen.findByText('b-skill@local-zip')).toBeTruthy();
    await installARejected;

    // A 的迟到二次确认要求落地：窗口必须仍是 B 的，不得被死流程换掉
    landA2(reqA2);
    await screen.findByRole('button', { name: cautionText.confirmInstall });
    expect(screen.getByText('b-skill@local-zip')).toBeTruthy();
    expect(screen.queryByText(cautionText.rules.history_clear)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    await expect(installB).resolves.toBeUndefined();
    // A 只到过首发 + 一次重发，重发的迟到结果没有第三跳
    expect(ipcInvoke.mock.calls.filter(([, spec]) => spec === 'a@market')).toHaveLength(2);
  });
});
