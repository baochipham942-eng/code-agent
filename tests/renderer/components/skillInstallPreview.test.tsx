// @vitest-environment jsdom
// ============================================================================
// 自定义 Skill 库 staged 装前预览流程测试
// mock invokeSkillIPC，覆盖：头部「添加技能」按钮打开 URL 弹窗、stage 成功
// 渲染预览弹窗、确认安装调 confirm、取消与 ESC 关闭都调 cancel、
// stage 失败在 URL 弹窗内联报错。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';
import type { StageRepositoryResult } from '../../../src/shared/contract/skillRepository';

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

vi.mock('../../../src/renderer/services/invokeSkillIPC', () => ({
  invokeSkillIPC: vi.fn(),
}));

import { invokeSkillIPC } from '../../../src/renderer/services/invokeSkillIPC';
import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';

const mockInvoke = vi.mocked(invokeSkillIPC);

const stageSuccess: StageRepositoryResult = {
  success: true,
  stageId: 'stage-1',
  repoId: 'foo-skills',
  repoName: 'foo-skills',
  sourceType: 'github',
  layout: 'library',
  skills: [
    {
      name: 'alpha',
      description: 'Alpha skill',
      skillMdContent:
        '---\nname: alpha\ndescription: Alpha skill\n---\n## Alpha Section\n\n**Alpha full body** with list\n\n- item one',
    },
    {
      name: 'beta',
      description: 'Beta skill',
      skillMdContent: 'Beta full body',
    },
  ],
  warnings: ['warning one'],
};

/** 按 channel 分发的默认 mock；stage/confirm/cancel 可由参数覆盖 */
function setupInvokeMock(overrides: {
  stage?: StageRepositoryResult;
  confirm?: { success: boolean; error?: string };
} = {}) {
  mockInvoke.mockImplementation((async (channel: string) => {
    switch (channel) {
      case SKILL_CHANNELS.REPO_LIST:
      case SKILL_CHANNELS.SKILL_LIST:
      case SKILL_CHANNELS.RECOMMENDED_REPOS:
        return [];
      case SKILL_CHANNELS.CATALOG:
        return undefined;
      case SKILL_CHANNELS.REGISTRY_LIST:
        return { items: [] };
      case SKILL_CHANNELS.REPO_STAGE:
        return overrides.stage ?? stageSuccess;
      case SKILL_CHANNELS.REPO_CONFIRM:
        return overrides.confirm ?? { success: true };
      case SKILL_CHANNELS.REPO_CANCEL:
        return undefined;
      default:
        return undefined;
    }
  }) as typeof invokeSkillIPC);
}

/** 点头部「添加技能」按钮打开 URL 弹窗，输入 URL 并提交 */
async function submitCustomUrl(url = 'https://github.com/user/foo-skills') {
  fireEvent.click(await screen.findByRole('button', { name: zh.settings.skills.main.addSkill }));
  const input = await screen.findByPlaceholderText('https://github.com/user/my-skills');
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(zh.settings.skills.main.addRepo) }));
}

function callsFor(channel: string) {
  return mockInvoke.mock.calls.filter(([called]) => called === channel);
}

describe('自定义库 staged 装前预览', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  afterEach(cleanup);

  it('stage 成功后渲染预览弹窗（repo 名、来源徽标、skill 列表、安全提示、警告）', async () => {
    setupInvokeMock();
    render(<SkillsSettings />);
    await submitCustomUrl();

    await screen.findByText('foo-skills');
    expect(callsFor(SKILL_CHANNELS.REPO_STAGE)).toEqual([
      [SKILL_CHANNELS.REPO_STAGE, 'https://github.com/user/foo-skills'],
    ]);
    // 来源徽标 + layout 说明
    expect(screen.getByText(zh.settings.skills.preview.sourceGithub)).toBeTruthy();
    expect(screen.getByText(/技能库 · 共 2 个 Skill/)).toBeTruthy();
    // skill 列表
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // 安全提示 + 警告条
    expect(screen.getByText(zh.settings.skills.preview.safetyNotice)).toBeTruthy();
    expect(screen.getByText('warning one')).toBeTruthy();
    // stage 之后不再直接落库
    expect(callsFor(SKILL_CHANNELS.REPO_ADD_CUSTOM)).toEqual([]);
  });

  it('头部「添加技能」按钮在两个 tab 下都可见，发现页不再有底部自定义区块', async () => {
    setupInvokeMock();
    render(<SkillsSettings />);
    // 已安装 tab（默认落点）
    expect(
      await screen.findByRole('button', { name: zh.settings.skills.main.addSkill })
    ).toBeTruthy();
    // 发现安装 tab
    fireEvent.click(screen.getByRole('tab', { name: zh.settings.skills.main.discoverTab }));
    expect(
      await screen.findByRole('button', { name: zh.settings.skills.main.addSkill })
    ).toBeTruthy();
    // 底部自定义区块已移除（未打开弹窗时页面不存在 URL 输入框）
    expect(screen.queryByPlaceholderText('https://github.com/user/my-skills')).toBeNull();
  });

  it('展开 skill 后 SKILL.md 渲染为 markdown，frontmatter 不进正文', async () => {
    setupInvokeMock();
    const { container } = render(<SkillsSettings />);
    await submitCustomUrl();
    await screen.findByText('foo-skills');

    fireEvent.click(screen.getByText('alpha'));
    // markdown 渲染产物：标题/加粗是语义元素而非裸文本
    // MarkdownCore 走 React.lazy，并行跑测试时 chunk 加载可能超过默认 1s，放宽等待
    expect(
      await screen.findByRole('heading', { name: 'Alpha Section' }, { timeout: 10000 })
    ).toBeTruthy();
    expect(await screen.findByText('Alpha full body')).toBeTruthy();
    // 不再是一坨等宽裸文本 <pre>
    expect(container.querySelector('pre')).toBeNull();
    // frontmatter 不出现在渲染正文（name/description 卡片上已有）
    expect(screen.queryByText(/name: alpha/)).toBeNull();
  });

  it('确认安装调 confirm，成功后刷新并关闭弹窗', async () => {
    setupInvokeMock();
    render(<SkillsSettings />);
    await submitCustomUrl();
    await screen.findByText('foo-skills');

    fireEvent.click(screen.getByRole('button', { name: zh.settings.skills.preview.confirmInstall }));

    await waitFor(() =>
      expect(callsFor(SKILL_CHANNELS.REPO_CONFIRM)).toEqual([[SKILL_CHANNELS.REPO_CONFIRM, 'stage-1']]),
    );
    expect(callsFor(SKILL_CHANNELS.REPO_CANCEL)).toEqual([]);
    // 弹窗关闭 + 成功提示 + 重新加载列表
    await waitFor(() => expect(screen.queryByText('warning one')).toBeNull());
    await screen.findByText(/安装成功/);
    expect(callsFor(SKILL_CHANNELS.REPO_LIST).length).toBeGreaterThan(1);
  });

  it('取消按钮调 cancel 并关闭弹窗', async () => {
    setupInvokeMock();
    render(<SkillsSettings />);
    await submitCustomUrl();
    await screen.findByText('foo-skills');

    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));

    await waitFor(() =>
      expect(callsFor(SKILL_CHANNELS.REPO_CANCEL)).toEqual([[SKILL_CHANNELS.REPO_CANCEL, 'stage-1']]),
    );
    expect(callsFor(SKILL_CHANNELS.REPO_CONFIRM)).toEqual([]);
    await waitFor(() => expect(screen.queryByText('warning one')).toBeNull());
  });

  it('ESC 关闭也调 cancel，不留孤儿 staging', async () => {
    setupInvokeMock();
    render(<SkillsSettings />);
    await submitCustomUrl();
    await screen.findByText('foo-skills');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(callsFor(SKILL_CHANNELS.REPO_CANCEL)).toEqual([[SKILL_CHANNELS.REPO_CANCEL, 'stage-1']]),
    );
    await waitFor(() => expect(screen.queryByText('warning one')).toBeNull());
  });

  it('confirm 失败在弹窗内展示错误，不静默关闭', async () => {
    setupInvokeMock({ confirm: { success: false, error: 'confirm boom' } });
    render(<SkillsSettings />);
    await submitCustomUrl();
    await screen.findByText('foo-skills');

    fireEvent.click(screen.getByRole('button', { name: zh.settings.skills.preview.confirmInstall }));

    await screen.findByText('confirm boom');
    // 弹窗仍在，staging 未 cancel（等用户决定）
    expect(screen.getByText('warning one')).toBeTruthy();
    expect(callsFor(SKILL_CHANNELS.REPO_CANCEL)).toEqual([]);
  });

  it('已安装冲突错误映射为人话，不透英文技术串', async () => {
    setupInvokeMock({
      confirm: { success: false, error: 'Repository already exists: foo-skills' },
    });
    render(<SkillsSettings />);
    await submitCustomUrl();
    await screen.findByText('foo-skills');

    fireEvent.click(screen.getByRole('button', { name: zh.settings.skills.preview.confirmInstall }));

    await screen.findByText(zh.settings.skills.preview.alreadyInstalled);
    expect(screen.queryByText(/Repository already exists/)).toBeNull();
  });

  it('stage 失败在 URL 弹窗内联报错，不弹预览', async () => {
    setupInvokeMock({ stage: { success: false, error: 'stage boom' } });
    render(<SkillsSettings />);
    await submitCustomUrl();

    await screen.findByText('stage boom');
    expect(screen.queryByText(zh.settings.skills.preview.safetyNotice)).toBeNull();
    expect(callsFor(SKILL_CHANNELS.REPO_CONFIRM)).toEqual([]);
    expect(callsFor(SKILL_CHANNELS.REPO_CANCEL)).toEqual([]);
  });

  it('非法 URL 直接展示校验错误，不调 stage', async () => {
    setupInvokeMock();
    render(<SkillsSettings />);
    await submitCustomUrl('https://example.com/not-a-repo');

    await screen.findByText(zh.settings.skills.main.invalidRepoUrl);
    expect(callsFor(SKILL_CHANNELS.REPO_STAGE)).toEqual([]);
  });

  it('魔搭（ModelScope）URL 通过校验并进入 stage 流程', async () => {
    setupInvokeMock({
      stage: { ...stageSuccess, sourceType: 'modelscope', layout: 'single-skill' },
    });
    render(<SkillsSettings />);
    await submitCustomUrl('https://www.modelscope.cn/ms-agent/skill_examples');

    await screen.findByText('foo-skills');
    expect(callsFor(SKILL_CHANNELS.REPO_STAGE)).toEqual([
      [SKILL_CHANNELS.REPO_STAGE, 'https://www.modelscope.cn/ms-agent/skill_examples'],
    ]);
    expect(screen.getByText(zh.settings.skills.preview.sourceModelscope)).toBeTruthy();
    expect(screen.getByText(zh.settings.skills.preview.layoutSingle)).toBeTruthy();
  });
});
