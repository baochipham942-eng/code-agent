// @vitest-environment jsdom
// ============================================================================
// ExternalImportInstructionRules 组件测试（N-EXTHISTORY-IMPORT-K1A-FU1 验收③）
// ============================================================================
//
// 走查口径：按 sourcePath 分组、默认收起、计数、上限提示、逐行状态
// （未导入 / 确认中 / 已导入 / 已拒绝 / 已导入过 / 无界面提示）、超限行只提示不拦截、
// 拆不出规则的用户级文件与项目级整文件各自的落行文案。

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MemoryImportDryRunResult } from '../../../src/shared/contract/memory';
import { zhSettingsExternalImport } from '../../../src/renderer/i18n/zhSettingsExternalImport';
import {
  ExternalImportInstructionRules,
  type DirectiveState,
} from '../../../src/renderer/components/features/settings/tabs/ExternalImportInstructionRules';
import type { ExternalImportCopy } from '../../../src/renderer/components/features/settings/tabs/ExternalImportSettings';

const copy = zhSettingsExternalImport.externalImport;

type InstructionItem = MemoryImportDryRunResult['instructions'][number];

function ruleItem(overrides: Partial<InstructionItem> & Pick<InstructionItem, 'id' | 'content' | 'contentHash'>): InstructionItem {
  return {
    adapterId: 'codex-local-custom',
    title: overrides.content,
    sourcePath: '/tmp/fixture-home/.codex/AGENTS.md',
    reason: 'directive-confirmation-required',
    sourceMetadata: { segmentOf: 'file-hash', segmentIndex: 0, segmentCount: 1 },
    ...overrides,
  } as InstructionItem;
}

function fileItem(reasonMetadata: Record<string, unknown>, sourcePath = '/tmp/fixture-home/.gemini/tmp/repo/memory/GEMINI.md'): InstructionItem {
  return {
    id: `instruction:${sourcePath}`,
    adapterId: 'gemini-cli',
    title: 'GEMINI.md',
    content: 'whole file',
    sourcePath,
    reason: 'instruction-file',
    contentHash: `hash-${reasonMetadata.segmentCount ?? 'project'}`,
    sourceMetadata: reasonMetadata,
  };
}

const onConfirmDirective = vi.fn();

function renderRules(
  instructions: InstructionItem[],
  directiveStates: Record<string, DirectiveState> = {},
  busy: string | null = null,
  homeDir?: string | null,
  onConfirm: (instructionId: string) => void = onConfirmDirective,
): void {
  render(
    <ExternalImportInstructionRules
      instructions={instructions}
      directiveStates={directiveStates}
      busy={busy}
      homeDir={homeDir}
      copy={copy as ExternalImportCopy}
      onConfirmDirective={onConfirm}
    />,
  );
}

afterEach(cleanup);

describe('ExternalImportInstructionRules 分组与收起（走查：默认收起 + 计数）', () => {
  it('按来源文件分组，默认收起只给路径与「找到 N 条规则」；展开后行是规则原文', () => {
    renderRules([
      ruleItem({ id: 'instruction:a', content: '每条回复结尾都带一行 —— 已收到', contentHash: 'ha' }),
      ruleItem({ id: 'instruction:b', content: '不要自动推送分支', contentHash: 'hb' }),
    ]);

    const group = screen.getByTestId('external-import-rule-group');
    expect(group.getAttribute('data-source-path')).toBe('/tmp/fixture-home/.codex/AGENTS.md');
    expect(screen.getByRole('button', { name: /找到 2 条规则/ }).getAttribute('aria-expanded')).toBe('false');
    // 收起时行不渲染
    expect(screen.queryByTestId('external-import-rule-row-ha')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /找到 2 条规则/ }));
    expect(screen.getByTestId('external-import-rule-row-ha').textContent)
      .toContain('每条回复结尾都带一行 —— 已收到');
    expect(screen.getByTestId('external-import-rule-row-hb').textContent).toContain('不要自动推送分支');
  });

  it('展开钮的箭头与文案是按钮 inline-flex 行里的兄弟节点，箭头不落进文案 span（FU1 返修验收②）', () => {
    renderRules([ruleItem({ id: 'instruction:a', content: '规则一', contentHash: 'ha' })]);

    const button = screen.getByRole('button', { name: /找到 1 条规则/ });
    expect(button.className).toContain('inline-flex');
    const spans = Array.from(button.children).filter((child) => child.tagName === 'SPAN');
    expect(spans).toHaveLength(2);
    const [labelSpan, iconSpan] = spans;
    expect(labelSpan?.textContent).toBe('找到 1 条规则');
    // 箭头 svg 不在文案 span 里：它与文案是同一 inline-flex 行的两个 flex 项
    expect(labelSpan?.querySelector('svg')).toBeNull();
    expect(iconSpan?.querySelector('svg')).toBeTruthy();
    expect(iconSpan?.parentElement).toBe(button);
  });

  it('两个来源文件各自分组，路径按 homeDir 缩写为 ~', () => {
    renderRules([
      ruleItem({ id: 'instruction:a', content: '规则一', contentHash: 'h1' }),
      ruleItem({ id: 'instruction:b', content: '规则二', contentHash: 'h2', sourcePath: '/tmp/fixture-home/.claude/CLAUDE.md' }),
    ], {}, null, '/tmp/fixture-home');

    const groups = screen.getAllByTestId('external-import-rule-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain('~/.codex/AGENTS.md');
    expect(groups[1]?.textContent).toContain('~/.claude/CLAUDE.md');
  });

  it('上限提示：新会话最多 10 条（约 800 字），数字来自 SEED_INJECTION', () => {
    renderRules([ruleItem({ id: 'instruction:a', content: '规则一', contentHash: 'h1' })]);
    expect(screen.getByTestId('external-import-rule-caphint').textContent)
      .toContain('新会话每次最多携带 10 条规则（约 800 字）');
  });

  it('整文件行：拆不出规则的用户级文件提示「没有可导入的单条规则」；项目级文件维持「只供对照，不写入」', () => {
    renderRules([
      fileItem({ segmentCount: 0 }, '/tmp/fixture-home/.codex/AGENTS.md'),
      fileItem({}),
    ]);

    const noRules = screen.getByTestId('external-import-rule-norules');
    expect(noRules.textContent).toBe('没有可导入的单条规则');
    expect(screen.getByText('只供对照，不写入')).toBeTruthy();
    // 没有规则分组时不出上限提示
    expect(screen.queryByTestId('external-import-rule-caphint')).toBeNull();
  });
});

describe('ExternalImportInstructionRules 逐行状态（走查六态）', () => {
  const oneRule = (id: string) => [ruleItem({
    id,
    content: `${id} 的规则原文`,
    contentHash: id.replace('instruction:', ''),
  })];

  it('未导入：行上有「导入这一条」按钮，点击走既有确认回调', () => {
    const onConfirm = vi.fn();
    renderRules(oneRule('instruction:x'), {}, null, undefined, onConfirm);
    fireEvent.click(screen.getByRole('button', { name: /找到 1 条规则/ }));
    fireEvent.click(screen.getByRole('button', { name: '导入这一条' }));
    expect(onConfirm).toHaveBeenCalledWith('instruction:x');
  });

  it('确认中：busy 命中该行时显示等待文案且按钮不再渲染', () => {
    renderRules(oneRule('instruction:x'), {}, 'directive:instruction:x');
    fireEvent.click(screen.getByRole('button', { name: /找到 1 条规则/ }));
    expect(screen.getByTestId('external-import-rule-row-x').textContent).toContain('等待确认…');
    expect(screen.queryByRole('button', { name: '导入这一条' })).toBeNull();
  });

  it('已导入 / 已拒绝 / 已导入过 / 无界面提示四种落行文案', () => {
    renderRules([
      ruleItem({ id: 'instruction:i', content: '规则一', contentHash: 'i' }),
      ruleItem({ id: 'instruction:d', content: '规则二', contentHash: 'd' }),
      ruleItem({ id: 'instruction:o', content: '规则三', contentHash: 'o' }),
      ruleItem({ id: 'instruction:h', content: '规则四', contentHash: 'h' }),
    ], {
      'instruction:i': 'imported',
      'instruction:d': 'declined',
      'instruction:o': 'already-imported',
      'instruction:h': 'headless',
    });
    fireEvent.click(screen.getByRole('button', { name: /找到 4 条规则/ }));

    expect(screen.getByTestId('external-import-rule-row-i').textContent).toContain('已导入');
    expect(screen.getByTestId('external-import-rule-row-d').textContent).toContain('未获确认，没有写入');
    expect(screen.getByTestId('external-import-rule-row-o').textContent).toContain('已导入过');
    expect(screen.getByTestId('external-import-rule-row-h').textContent).toContain('请在应用里完成这条的确认');
    // 四行都不再给导入按钮
    expect(screen.queryByRole('button', { name: '导入这一条' })).toBeNull();
  });

  it('确认失败态：显示「确认失败」', () => {
    renderRules(oneRule('instruction:f'), { 'instruction:f': 'failed' });
    fireEvent.click(screen.getByRole('button', { name: /找到 1 条规则/ }));
    expect(screen.getByTestId('external-import-rule-row-f').textContent).toContain('确认失败');
  });

  it('超出新会话上限的行：标注「超出新会话上限，暂不会生效」，但导入按钮仍在（不拦截）', () => {
    const rules = Array.from({ length: 12 }, (_, i) =>
      ruleItem({ id: `instruction:r${i}`, content: `规则${i}`, contentHash: `r${i}` }));
    renderRules(rules);
    fireEvent.click(screen.getByRole('button', { name: /找到 12 条规则/ }));

    const overCap = screen.getAllByTestId('external-import-rule-overcap');
    // 第 11、12 行超限
    expect(overCap).toHaveLength(2);
    expect(screen.getByTestId('external-import-rule-row-r10').textContent).toContain('超出新会话上限，暂不会生效');
    expect(screen.getByTestId('external-import-rule-row-r0').textContent).not.toContain('超出新会话上限');
    // 不拦截：超限行的导入按钮仍在
    expect(screen.getAllByRole('button', { name: '导入这一条' }).length).toBeGreaterThan(0);
  });
});
