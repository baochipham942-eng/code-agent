// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import type { EvalCaseListItem } from '../../../src/shared/contract/evaluation';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@internal-evaluation/renderer/evaluationRunIpc', () => ({
  invokeEvaluation: ipc.invoke,
}));

import { EvalCaseListTab } from '@internal-evaluation/renderer/evalCenter/EvalCaseListTab';

const ITEMS: EvalCaseListItem[] = [
  {
    id: 'daily-case',
    file: '01-tools.yaml',
    relativeDir: '',
    layer: '工具与任务基础',
    tags: ['own-tag'],
    inheritedTags: ['suite-tag'],
    splits: ['held-in', 'control'],
    turns: 1,
    hasExpect: true,
    hardened: true,
    source: 'manual',
    retired: false,
    isDraft: false,
  },
  {
    id: 'archived-case',
    file: '02-tasks.yaml',
    relativeDir: '',
    layer: '工具与任务基础',
    tags: [],
    inheritedTags: ['task'],
    splits: ['held-out'],
    turns: 2,
    hasExpect: true,
    hardened: true,
    source: 'session',
    retired: true,
    isDraft: false,
  },
  {
    id: 'draft-case',
    file: 'drafts/draft-case.yaml',
    relativeDir: 'drafts',
    layer: '草稿',
    tags: [],
    inheritedTags: [],
    splits: [],
    turns: 'simulator',
    hasExpect: false,
    hardened: false,
    reviewStatus: 'pending',
    source: 'manual',
    retired: false,
    isDraft: true,
  },
];

beforeEach(() => {
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === EVALUATION_CHANNELS.LIST_CASES) return ITEMS;
    return { action: 'archive', id: 'daily-case', file: '01-tools.yaml' };
  });
});

afterEach(() => {
  cleanup();
  ipc.invoke.mockReset();
});

describe('EvalCaseListTab', () => {
  it('展示自有/继承标签、校准样本和草稿，默认隐藏已归档', async () => {
    render(<EvalCaseListTab />);

    expect(await screen.findByTestId('eval-case-row-daily-case')).toBeTruthy();
    expect(screen.getByText('own-tag')).toBeTruthy();
    expect(screen.getByText('suite-tag').getAttribute('title')).toBe('继承自文件');
    expect(screen.getByText('校准样本')).toBeTruthy();
    expect(screen.getByTestId('eval-case-row-draft-case')).toBeTruthy();
    expect(screen.getAllByText('还没有判定标准')).toHaveLength(2);
    const draftRow = screen.getByTestId('eval-case-row-draft-case');
    expect(draftRow.getAttribute('aria-disabled')).toBe('true');
    expect(draftRow.className).toContain('opacity-60');
    expect(draftRow.className).toContain('saturate-50');
    expect(screen.getByText('不会进跑分')).toBeTruthy();
    const dailyRow = screen.getByTestId('eval-case-row-daily-case');
    expect(dailyRow.getAttribute('aria-disabled')).toBeNull();
    expect(dailyRow.className).not.toContain('saturate-50');
    expect(dailyRow.textContent).not.toContain('不会进跑分');
    expect(screen.queryByTestId('eval-case-row-archived-case')).toBeNull();
  });

  it('reviewStatus:pending 但 expect 非空的题仍禁选（hardened=false 而 hasExpect=true · Grok 盲区③ 监工代笔）', async () => {
    const pendingHardened: EvalCaseListItem = {
      id: 'pending-case', file: '01-tools.yaml', relativeDir: '', layer: '工具与任务基础',
      tags: [], inheritedTags: [], splits: ['held-in'], turns: 1,
      hasExpect: true, hardened: false, reviewStatus: 'pending',
      source: 'manual', retired: false, isDraft: false,
    };
    ipc.invoke.mockImplementation(async (channel: string) =>
      (channel === EVALUATION_CHANNELS.LIST_CASES ? [pendingHardened] : { action: 'archive', id: 'x', file: 'x' }));
    render(<EvalCaseListTab />);
    const row = await screen.findByTestId('eval-case-row-pending-case');
    // hasExpect=true 但 reviewStatus=pending ⇒ hardened=false ⇒ 必须禁选；谓词退化成 !item.hasExpect 会漏禁这类题
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.className).toContain('saturate-50');
    expect(row.textContent).toContain('不会进跑分');
  });

  it('状态筛选可单独查看已归档题', async () => {
    render(<EvalCaseListTab />);
    await screen.findByTestId('eval-case-row-daily-case');

    fireEvent.change(screen.getAllByRole('combobox')[3], { target: { value: 'archived' } });

    expect(screen.getByTestId('eval-case-row-archived-case')).toBeTruthy();
    expect(screen.queryByTestId('eval-case-row-daily-case')).toBeNull();
  });

  it('新增草稿和归档都调用 save-case，归档前先显示 warning 确认框', async () => {
    render(<EvalCaseListTab />);
    await screen.findByTestId('eval-case-row-daily-case');

    fireEvent.click(screen.getByText('新增草稿'));
    fireEvent.change(screen.getByPlaceholderText('例如 report-q3-summary'), { target: { value: 'new-report' } });
    fireEvent.change(screen.getByPlaceholderText('写清楚希望 Neo 完成的任务'), { target: { value: '生成报告' } });
    fireEvent.change(screen.getByPlaceholderText('用逗号分隔，例如 report, html'), { target: { value: 'report, html' } });
    fireEvent.click(screen.getByText('保存草稿'));

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(
      EVALUATION_CHANNELS.SAVE_CASE,
      { action: 'create-draft', id: 'new-report', prompt: '生成报告', tags: ['report', 'html'] },
    ));

    fireEvent.click(screen.getAllByText('归档')[0]);
    expect(screen.getByText('归档后会在原 YAML 中记录日期，题目仍保留，可在“已归档”筛选中找到。')).toBeTruthy();
    fireEvent.click(screen.getByText('确认归档'));

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(
      EVALUATION_CHANNELS.SAVE_CASE,
      { action: 'archive', id: 'daily-case' },
    ));
  });
});
