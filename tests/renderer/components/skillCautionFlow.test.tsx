// @vitest-environment jsdom
// ============================================================================
// SkillsSettings 的 skill caution 披露流程测试（jsdom 交互链路）
// 覆盖：本地 ZIP 返回 SKILL_CAUTION_CONFIRMATION_REQUIRED → 弹 confirm 模式 →
// 确认携 token 原样重发 → 成功提示；取消不重发；内容变化的二次确认用新命中重开；
// registry 带 cautionHits 装完弹 acknowledge；不带 hits 不弹任何东西。
// mock 风格对齐 skillInstallPreview.test.tsx（invokeSkillIPC/OrThrow 共用一个桩）。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';
import type { SkillRegistryListItem } from '../../../src/shared/contract/skillRegistry';
import type { SkillCautionConfirmationRequired } from '../../../src/shared/contract/skillInstallCaution';

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

// 本地 ZIP 走原生文件选择（非 web 模式），桩掉文件对话框
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  pickNativeFile: vi.fn().mockResolvedValue('/tmp/caution.zip'),
  saveNativeFile: vi.fn(),
}));

import { invokeSkillIPC } from '../../../src/renderer/services/invokeSkillIPC';
import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';

const mockInvoke = vi.mocked(invokeSkillIPC);
const cautionText = zh.settings.skills.caution;

const registryItem: SkillRegistryListItem = {
  entry: {
    name: 'demo-skill',
    displayName: '演示技能',
    description: 'demo entry',
    repository: 'owner/demo-repo',
    pinnedCommit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    skills: ['demo'],
    publisher: 'Neo 官方',
    reviewedAt: '2026-09-01',
  },
  installed: false,
  hasUpdate: false,
};

function confirmationRequired(overrides: {
  cautionHits?: SkillCautionConfirmationRequired['cautionHits'];
  confirmationToken?: string;
} = {}): SkillCautionConfirmationRequired {
  return {
    success: false,
    code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED',
    pluginSpec: 'demo@local-zip',
    sourceTrust: 'local-marketplace',
    cautionHits: overrides.cautionHits ?? [
      { file: 'demo/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' },
    ],
    confirmationToken: overrides.confirmationToken ?? 'token-1',
  };
}

/** 按 channel 分发的默认 mock；registry 装载与本地 ZIP 按序消费队列 */
function setupInvokeMock(overrides: {
  registryList?: SkillRegistryListItem[];
  registryInstall?: unknown;
  zipResults?: unknown[];
} = {}) {
  const zipResults = [...(overrides.zipResults ?? [])];
  mockInvoke.mockImplementation((async (channel: string) => {
    switch (channel) {
      case SKILL_CHANNELS.REPO_LIST:
      case SKILL_CHANNELS.SKILL_LIST:
      case SKILL_CHANNELS.RECOMMENDED_REPOS:
        return [];
      case SKILL_CHANNELS.CATALOG:
        // 置空目录：发现页只剩 registry 卡，避免与推荐卡的「安装」按钮混名
        return { categories: [], skills: [], bundles: [], repositories: [] };
      case SKILL_CHANNELS.REGISTRY_LIST:
        return { items: overrides.registryList ?? [] };
      case SKILL_CHANNELS.REGISTRY_INSTALL:
        return overrides.registryInstall ?? { success: true };
      case SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP:
        return zipResults.shift() ?? { success: true, skillName: 'demo' };
      default:
        return undefined;
    }
  }) as typeof invokeSkillIPC);
}

/** 已安装 tab → 「从 ZIP 安装」（按钮可及名走 aria-label） */
async function startZipInstall() {
  fireEvent.click(await screen.findByRole('tab', { name: /已安装/ }));
  fireEvent.click(
    await screen.findByRole('button', { name: zh.settings.skills.installed.installFromZipAria }),
  );
}

function callsFor(channel: string) {
  return mockInvoke.mock.calls.filter(([called]) => called === channel);
}

describe('SkillsSettings caution 披露流程', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  afterEach(cleanup);

  it('本地 ZIP 返回 confirmation-required → 弹确认；确认携 token 原样重发 → 成功提示', async () => {
    setupInvokeMock({
      zipResults: [
        confirmationRequired(),
        { success: true, skillName: 'demo' },
      ],
    });
    render(<SkillsSettings />);
    await startZipInstall();

    // 确认面：标题 / 来源标签 / 命中（rule id + snippet）
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    expect(screen.getByText('demo@local-zip')).toBeTruthy();
    expect(screen.getByText(cautionText.sourceLabels['local-marketplace'])).toBeTruthy();
    expect(screen.getByText('git_clean')).toBeTruthy();
    expect(screen.getByText('git clean -fd')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    await waitFor(() => {
      expect(callsFor(SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP)).toEqual([
        [SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP, { zipPath: '/tmp/caution.zip' }],
        [
          SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP,
          { zipPath: '/tmp/caution.zip', cautionConfirmationToken: 'token-1' },
        ],
      ]);
    }, { timeout: 5000 });
    // 成功提示 + 弹窗关闭
    await screen.findByText(/已安装 demo/);
    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull(), { timeout: 5000 });
  });

  it('取消 → 不发第二次 IPC，弹窗关闭', async () => {
    setupInvokeMock({ zipResults: [confirmationRequired()] });
    render(<SkillsSettings />);
    await startZipInstall();

    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));

    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull(), { timeout: 5000 });
    expect(callsFor(SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP)).toEqual([
      [SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP, { zipPath: '/tmp/caution.zip' }],
    ]);
  });

  it('内容变化的二次 confirmation-required：新命中重开弹窗，确认改用新 token', async () => {
    setupInvokeMock({
      zipResults: [
        confirmationRequired(),
        confirmationRequired({
          cautionHits: [{ file: 'demo/SKILL.md', ruleId: 'rm_rf_dist', snippet: 'rm -rf ./dist' }],
          confirmationToken: 'token-2',
        }),
        { success: true, skillName: 'demo' },
      ],
    });
    render(<SkillsSettings />);
    await startZipInstall();

    expect(await screen.findByText('git_clean')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    // 二次确认：弹窗不关，换成新命中/新 token 语义
    await screen.findByText('rm_rf_dist');
    expect(screen.getByText('rm -rf ./dist')).toBeTruthy();
    expect(screen.queryByText('git_clean')).toBeNull();
    expect(screen.queryByText('git clean -fd')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));

    await waitFor(() => {
      const calls = callsFor(SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual([
        SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP,
        { zipPath: '/tmp/caution.zip', cautionConfirmationToken: 'token-2' },
      ]);
    }, { timeout: 5000 });
    await screen.findByText(/已安装 demo/);
  });

  it('registry 带 cautionHits：装完弹 acknowledge（仅 OK，无确认安装）', async () => {
    setupInvokeMock({
      registryList: [registryItem],
      registryInstall: {
        success: true,
        cautionHits: [{ file: 'SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' }],
      },
    });
    render(<SkillsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: zh.settings.skills.discover.registryInstall }));

    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    expect(screen.getByText(cautionText.acknowledgeExplanation)).toBeTruthy();
    // 发现页卡片（h5）与弹窗头部（h3）同名并存
    expect(screen.getAllByText('演示技能')).toHaveLength(2);
    // 来源标签与发现页小节标题同名，卡片+弹窗各一处
    expect(screen.getAllByText(cautionText.sourceLabels['official-registry']).length).toBeGreaterThan(0);
    expect(screen.getByText('git_clean')).toBeTruthy();
    // acknowledge：单 OK 按钮，没有确认安装
    expect(screen.getByRole('button', { name: cautionText.okButton })).toBeTruthy();
    expect(screen.queryByRole('button', { name: cautionText.confirmInstall })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: cautionText.okButton }));
    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull(), { timeout: 5000 });
  });

  it('registry 不带 cautionHits：不弹任何披露', async () => {
    setupInvokeMock({
      registryList: [registryItem],
      registryInstall: { success: true },
    });
    render(<SkillsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: zh.settings.skills.discover.registryInstall }));

    await screen.findByText(/安装成功/);
    expect(screen.queryByText(cautionText.title)).toBeNull();
    expect(callsFor(SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP)).toEqual([]);
  });

  it('未识别的 SKILL_* 机器码错误：退本地化通用文案，不把裸码糊上界面', async () => {
    setupInvokeMock({
      zipResults: [{ success: false, error: 'SKILL_ZIP_INSTALL_FAILED' }],
    });
    render(<SkillsSettings />);
    await startZipInstall();

    expect(await screen.findByText(zh.settings.skills.main.zipInstallFailed)).toBeTruthy();
    expect(screen.queryByText('SKILL_ZIP_INSTALL_FAILED')).toBeNull();
    // 未识别的其它 SKILL_* 码同样收口（host 新增错误码时不许裸奔到界面）
    mockInvoke.mockImplementation(async () => ({ success: false, error: 'SKILL_ZIP_SOMETHING_NEW' }));
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.skills.installed.installFromZipAria }));
    expect(await screen.findByText(zh.settings.skills.main.zipInstallFailed)).toBeTruthy();
    expect(screen.queryByText('SKILL_ZIP_SOMETHING_NEW')).toBeNull();
  });
});
