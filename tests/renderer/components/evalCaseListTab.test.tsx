// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { EvalCaseListItem } from '../../../src/shared/contract/evaluation';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: ipc.invoke },
}));

import { EvalCaseListTab } from '../../../src/renderer/components/features/evalCenter/EvalCaseListTab';

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
    reviewStatus: 'pending',
    source: 'manual',
    retired: false,
    isDraft: true,
  },
];

beforeEach(() => {
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.EVALUATION_LIST_CASES) return ITEMS;
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
    expect(screen.queryByTestId('eval-case-row-archived-case')).toBeNull();
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
      IPC_CHANNELS.EVALUATION_SAVE_CASE,
      { action: 'create-draft', id: 'new-report', prompt: '生成报告', tags: ['report', 'html'] },
    ));

    fireEvent.click(screen.getAllByText('归档')[0]);
    expect(screen.getByText('归档后会在原 YAML 中记录日期，题目仍保留，可在“已归档”筛选中找到。')).toBeTruthy();
    fireEvent.click(screen.getByText('确认归档'));

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.EVALUATION_SAVE_CASE,
      { action: 'archive', id: 'daily-case' },
    ));
  });
});
