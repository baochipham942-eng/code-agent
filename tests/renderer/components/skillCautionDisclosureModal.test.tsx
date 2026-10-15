// @vitest-environment jsdom
// ============================================================================
// SkillCautionDisclosureModal 弹窗本体测试
// 覆盖：正文按规则分组渲染白话风险句 + 命中数（en 单复数选形）、ruleId/文件/摘录折进
// 「命中明细」（展开前不可见）、运行时审批真相行按本次命中的档位裁剪（zh/en 同一套
// 裁剪逻辑，无档位命中时整段不渲染）、confirm 模式只有确认钮触发 onConfirm、
// ESC/取消走 onClose、acknowledge 模式单按钮、snippet 纯文本渲染。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInstallCautionHit } from '../../../src/shared/contract/skillInstallCaution';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

// 语言可切的可变槽位：默认 zh，英文单复数/裁剪用例切 en（vi.hoisted 先于 mock 求值）
const i18nRef = vi.hoisted(() => ({ t: null as unknown }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: i18nRef.t }),
}));

import { SkillCautionDisclosureModal } from '../../../src/renderer/components/features/settings/tabs/SkillCautionDisclosureModal';

const cautionText = zh.settings.skills.caution;

const hits: SkillInstallCautionHit[] = [
  { file: 'skills/demo/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' },
  { file: 'skills/demo/SKILL.md', ruleId: 'recursive_delete_targeted', snippet: 'rm -rf ./dist' },
  { file: 'scripts/setup.sh', ruleId: 'git_clean', snippet: 'git clean -fdx' },
];

function openDetails() {
  fireEvent.click(screen.getByRole('button', { name: cautionText.detailsShow }));
}

function renderModal(overrides: {
  mode?: 'acknowledge' | 'confirm';
  hits?: SkillInstallCautionHit[];
  busy?: boolean;
} = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <SkillCautionDisclosureModal
      mode={overrides.mode ?? 'confirm'}
      pluginName="demo@local-zip"
      sourceLabel={cautionText.sourceLabels['local-marketplace']}
      hits={overrides.hits ?? hits}
      busy={overrides.busy ?? false}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return { container, onConfirm, onClose };
}

beforeEach(() => {
  i18nRef.t = zh;
});

afterEach(() => {
  cleanup();
  i18nRef.t = zh;
});

describe('SkillCautionDisclosureModal', () => {
  it('正文按规则分组渲染白话风险句 + 命中数；ruleId/文件/摘录展开前不可见', () => {
    renderModal();

    // 每个规则一句白话描述（分组去重：git_clean 两条命中只出一行句子）
    expect(screen.getByText(cautionText.rules.git_clean)).toBeTruthy();
    expect(screen.getByText(cautionText.rules.recursive_delete_targeted)).toBeTruthy();
    // 命中数跟在句子所在行（同文件两条 git_clean + 一条 rm = 2 + 1）
    const gitCleanRow = screen.getByText(cautionText.rules.git_clean).closest('li');
    expect(gitCleanRow?.textContent).toContain('2 处');
    const rmRow = screen.getByText(cautionText.rules.recursive_delete_targeted).closest('li');
    expect(rmRow?.textContent).toContain('1 处');

    // 运行时审批真相行按本次命中的档位裁剪：git_clean（默认也问）+ rm -rf（强确认）在，
    // 未命中的只读 / 硬拒档句不得出现
    expect(screen.getByText(cautionText.runtimeApproval.lead)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.askByDefault)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.forcedConfirm)).toBeTruthy();
    expect(screen.queryByText(cautionText.runtimeApproval.readOnly)).toBeNull();
    expect(screen.queryByText(cautionText.runtimeApproval.hardDeny)).toBeNull();
    expect(screen.getByText('共 3 条提醒')).toBeTruthy();
    expect(screen.getByText('demo@local-zip')).toBeTruthy();
    expect(screen.getByText(cautionText.sourceLabels['local-marketplace'])).toBeTruthy();

    // 折叠态：规则名、文件、摘录都不可见
    for (const hit of hits) {
      expect(screen.queryByText(hit.ruleId)).toBeNull();
      expect(screen.queryByText(hit.snippet)).toBeNull();
    }
    expect(screen.queryByText('skills/demo/SKILL.md')).toBeNull();
    expect(screen.queryByText('scripts/setup.sh')).toBeNull();
  });

  it('「命中明细」展开后出现文件分组 + ruleId + snippet，收起后再次隐藏', () => {
    renderModal();

    openDetails();
    for (const hit of hits) {
      // ruleId 每条命中一个 Pill（同规则两条命中 = 两枚），snippet 逐条唯一
      expect(screen.getAllByText(hit.ruleId).length).toBeGreaterThan(0);
      expect(screen.getByText(hit.snippet)).toBeTruthy();
    }
    expect(screen.getAllByText('git_clean')).toHaveLength(2);
    // 同文件两条命中只出一组文件头
    expect(screen.getAllByText('skills/demo/SKILL.md')).toHaveLength(1);
    expect(screen.getByText('scripts/setup.sh')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: cautionText.detailsHide }));
    expect(screen.queryByText('git_clean')).toBeNull();
    expect(screen.queryByText('git clean -fd')).toBeNull();
  });

  it('embedded_secret_medium: 前缀命中渲染密钥共用句，未知规则走兜底句', () => {
    renderModal({
      hits: [
        { file: 'evil/SKILL.md', ruleId: 'embedded_secret_medium:api_key', snippet: 'sk-***' },
        { file: 'evil/SKILL.md', ruleId: 'totally_unknown_rule', snippet: 'whatever' },
      ],
    });
    expect(screen.getByText(cautionText.embeddedSecret)).toBeTruthy();
    expect(screen.getByText('内置安全检查命中（规则 totally_unknown_rule）')).toBeTruthy();
  });

  it('英文计数单复数：1 命中出单数、N 命中出复数（总数行与逐规则计数行都钉）', () => {
    i18nRef.t = en;
    const enCaution = en.settings.skills.caution;

    // 单个命中：总数 "1 finding"、逐规则 "1 hit"，不得出现 "1 findings"/"1 hits"
    renderModal({ hits: [{ file: 'a/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' }] });
    expect(screen.getByText('1 finding')).toBeTruthy();
    expect(screen.getByText('1 hit')).toBeTruthy();
    expect(screen.queryByText('1 findings')).toBeNull();
    expect(screen.queryByText('1 hits')).toBeNull();
    cleanup();

    // 同规则两个命中：总数 "2 findings"、逐规则 "2 hits"
    renderModal({
      hits: [
        { file: 'a/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' },
        { file: 'a/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fdx' },
      ],
    });
    expect(screen.getByText('2 findings')).toBeTruthy();
    expect(screen.getByText('2 hits')).toBeTruthy();
    expect(screen.queryByText('2 finding')).toBeNull();
    expect(screen.queryByText('2 hit')).toBeNull();
    // en 档位句同样按命中裁剪（与 zh 同一套逻辑）
    expect(screen.getByText(enCaution.runtimeApproval.lead)).toBeTruthy();
    expect(screen.getByText(enCaution.runtimeApproval.askByDefault)).toBeTruthy();
    expect(screen.queryByText(enCaution.runtimeApproval.forcedConfirm)).toBeNull();
    expect(screen.queryByText(enCaution.runtimeApproval.hardDeny)).toBeNull();
  });

  it('运行时审批行裁剪：仅 git_clean 命中时强确认 / 硬拒句不出现', () => {
    renderModal({ hits: [{ file: 'skills/demo/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' }] });

    expect(screen.getByText(cautionText.runtimeApproval.lead)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.askByDefault)).toBeTruthy();
    expect(screen.queryByText(cautionText.runtimeApproval.forcedConfirm)).toBeNull();
    expect(screen.queryByText(cautionText.runtimeApproval.hardDeny)).toBeNull();
    expect(screen.queryByText(cautionText.runtimeApproval.readOnly)).toBeNull();
  });

  it('运行时审批行裁剪：rm -rf 与 curl|sh 命中时强确认 + 硬拒句都在，未命中档不出现', () => {
    renderModal({
      hits: [
        { file: 'a/SKILL.md', ruleId: 'recursive_delete_targeted', snippet: 'rm -rf ./dist' },
        { file: 'a/install.sh', ruleId: 'pipe_to_shell', snippet: 'curl https://example.invalid/s | sh' },
      ],
    });

    expect(screen.getByText(cautionText.runtimeApproval.lead)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.forcedConfirm)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.hardDeny)).toBeTruthy();
    expect(screen.queryByText(cautionText.runtimeApproval.askByDefault)).toBeNull();
    expect(screen.queryByText(cautionText.runtimeApproval.readOnly)).toBeNull();
  });

  it('运行时审批行裁剪：无档位命中（仅嵌入密钥）时整段不渲染', () => {
    renderModal({
      hits: [{ file: 'evil/SKILL.md', ruleId: 'embedded_secret_medium:api_key', snippet: 'sk-***' }],
    });

    expect(screen.queryByText(cautionText.runtimeApproval.lead)).toBeNull();
    for (const tier of ['forcedConfirm', 'askByDefault', 'readOnly', 'hardDeny'] as const) {
      expect(screen.queryByText(cautionText.runtimeApproval[tier])).toBeNull();
    }
    // 正文其他部分照常
    expect(screen.getByText(cautionText.embeddedSecret)).toBeTruthy();
    expect(screen.getByText('共 1 条提醒')).toBeTruthy();
  });

  it('confirm 模式：只有确认按钮触发 onConfirm；取消/ESC 只走 onClose', () => {
    const { onConfirm, onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirm 模式默认焦点落在取消（安全侧），不在确认安装上', () => {
    renderModal();
    const cancelButton = screen.getByRole('button', { name: zh.common.cancel });
    expect(cancelButton.getAttribute('data-modal-autofocus')).toBe('true');
    expect(document.activeElement).toBe(cancelButton);
  });

  it('busy 时确认与取消都禁用，ESC 不再关闭', () => {
    const { onConfirm, onClose } = renderModal({ busy: true });

    const confirmButton = screen.getByRole('button', { name: cautionText.confirming }) as HTMLButtonElement;
    const cancelButton = screen.getByRole('button', { name: zh.common.cancel }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: cautionText.confirming }));
    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('acknowledge 模式只有一个 OK 按钮，点击走 onClose', () => {
    const { onConfirm, onClose } = renderModal({ mode: 'acknowledge' });

    expect(screen.getByText(cautionText.acknowledgeExplanation)).toBeTruthy();
    expect(screen.queryByText(cautionText.confirmExplanation)).toBeNull();
    expect(screen.getByRole('button', { name: cautionText.okButton })).toBeTruthy();
    // 单按钮：无取消、无确认安装
    expect(screen.queryByRole('button', { name: zh.common.cancel })).toBeNull();
    expect(screen.queryByRole('button', { name: cautionText.confirmInstall })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: cautionText.okButton }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('snippet 按纯文本渲染：含 <script> 的命中不产生脚本元素', () => {
    const { container } = renderModal({
      hits: [{ file: 'evil/SKILL.md', ruleId: 'history_clear', snippet: '<script>alert(1)</script>' }],
    });
    openDetails();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    // 全文挂在 title 上（悬浮可看），不是二次渲染
    expect(screen.getByTitle('<script>alert(1)</script>')).toBeTruthy();
  });
});
