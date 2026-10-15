// @vitest-environment jsdom
// ============================================================================
// SkillCautionDisclosureModal 弹窗本体测试
// 覆盖：正文按规则分组渲染白话风险句 + 命中数、ruleId/文件/摘录折进「命中明细」
// （展开前不可见）、运行时审批真相行常驻、confirm 模式只有确认钮触发 onConfirm、
// ESC/取消走 onClose、acknowledge 模式单按钮、snippet 纯文本渲染。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillInstallCautionHit } from '../../../src/shared/contract/skillInstallCaution';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
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

afterEach(() => cleanup());

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

    // 运行时审批真相行常驻正文
    expect(screen.getByText(cautionText.runtimeApprovalLine)).toBeTruthy();
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
