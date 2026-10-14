// @vitest-environment jsdom
// ============================================================================
// SkillCautionDisclosureModal 弹窗本体测试
// 覆盖：每条命中渲染 rule id + snippet 且按文件分组、confirm 模式只有确认钮触发
// onConfirm、ESC/取消走 onClose、acknowledge 模式单按钮、snippet 纯文本渲染。
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
  { file: 'skills/demo/SKILL.md', ruleId: 'curl_local', snippet: 'curl http://localhost:9527/api' },
  { file: 'scripts/setup.sh', ruleId: 'rm_rf_dist', snippet: 'rm -rf ./dist' },
];

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
  it('渲染每条命中（rule id + snippet），同文件命中归组、计数准确', () => {
    renderModal();
    for (const hit of hits) {
      expect(screen.getByText(hit.ruleId)).toBeTruthy();
      expect(screen.getByText(hit.snippet)).toBeTruthy();
    }
    // 同文件两条命中只出一组文件头
    expect(screen.getAllByText('skills/demo/SKILL.md')).toHaveLength(1);
    expect(screen.getByText('scripts/setup.sh')).toBeTruthy();
    expect(screen.getByText('共 3 条提醒')).toBeTruthy();
    expect(screen.getByText('demo@local-zip')).toBeTruthy();
    expect(screen.getByText(cautionText.sourceLabels['local-marketplace'])).toBeTruthy();
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
      hits: [{ file: 'evil/SKILL.md', ruleId: 'html_inject', snippet: '<script>alert(1)</script>' }],
    });
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    // 全文挂在 title 上（悬浮可看），不是二次渲染
    expect(screen.getByTitle('<script>alert(1)</script>')).toBeTruthy();
  });
});
