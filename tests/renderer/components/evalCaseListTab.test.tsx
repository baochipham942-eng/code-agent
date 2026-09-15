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

  it('分布矩阵：列按契约四值 + 其他 + 未填归一，未填列不标红，已归档/草稿不计', async () => {
    const base = { file: 'x.yaml', relativeDir: '', tags: [], inheritedTags: [], splits: ['held-in' as const], turns: 1, hasExpect: true, hardened: true, source: 'manual' as const, isDraft: false };
    const items: EvalCaseListItem[] = [
      { ...base, id: 'a', layer: 'L1', category: 'basic_tool', retired: false },
      { ...base, id: 'b', layer: 'L1', category: 'task_completion', retired: false },
      { ...base, id: 'c', layer: 'L2', category: 'basic_tool', retired: false },
      // 契约外的自由文本值：归入「其他」列，不是脏轴也不是盲区
      { ...base, id: 'f', layer: 'L1', category: 'formula', retired: false },
      // 没填 category：进「未填」列
      { ...base, id: 'n', layer: 'L2', retired: false },
      // 已归档的题恰好落在空格上：算进去矩阵就没有盲区了
      { ...base, id: 'd-archived', layer: 'L2', category: 'task_completion', retired: true },
      { ...base, id: 'e-draft', file: 'drafts/e.yaml', relativeDir: 'drafts', layer: 'L2', category: 'task_completion', retired: false, isDraft: true },
    ];
    ipc.invoke.mockImplementation(async (channel: string) =>
      (channel === EVALUATION_CHANNELS.LIST_CASES ? items : { action: 'archive', id: 'x', file: 'x' }));
    render(<EvalCaseListTab />);
    // 默认收起，展开后才渲染矩阵表
    fireEvent.click(await screen.findByTestId('eval-case-matrix-toggle'));
    await screen.findByTestId('eval-case-matrix');

    // 2 行 × 6 列（basic_tool / task_completion / error_recovery / edge_case / 其他 / 未填）
    const headers = [...screen.getByTestId('eval-case-matrix').querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['层别', 'basic_tool', 'task_completion', 'error_recovery', 'edge_case', '其他（1 种）', '未填']);

    // 有数格：L1/basic_tool、L1/task_completion、L1/其他、L2/basic_tool、L2/未填，外加不标红的 L1/未填(0)
    const filled = screen.getAllByTestId('eval-case-matrix-cell');
    expect(filled).toHaveLength(6);
    // 红格 6 个：两行各 4 契约列 + 其他列 = 10 格，减去 4 个有数的
    const empty = screen.getAllByTestId('eval-case-matrix-empty');
    expect(empty).toHaveLength(6);
    expect(empty.every((cell) => cell.className.includes('text-badge-danger'))).toBe(true);

    // 「未填」列的 0 不标红
    const l1Cells = [...(screen.getAllByTestId('eval-case-matrix-cell')[0].closest('tr') as HTMLTableRowElement).querySelectorAll('td')];
    expect(l1Cells[0].textContent).toBe('L1');
    expect(l1Cells[6].textContent).toBe('0');
    expect(l1Cells[6].getAttribute('data-testid')).toBe('eval-case-matrix-cell');

    expect(screen.getByTestId('eval-case-matrix-missing-note').textContent)
      .toContain('未填 category 的在用题 1/5');
  });

  it('分布矩阵默认收起，摘要报格数/红格/未填，点击展开后才渲染矩阵表（FB-160）', async () => {
    const base = { file: 'x.yaml', relativeDir: '', tags: [], inheritedTags: [], splits: ['held-in' as const], turns: 1, hasExpect: true, hardened: true, source: 'manual' as const, isDraft: false, retired: false };
    const items: EvalCaseListItem[] = [
      { ...base, id: 'a', layer: 'L1', category: 'basic_tool' },
      { ...base, id: 'n', layer: 'L1' },
    ];
    ipc.invoke.mockImplementation(async (channel: string) =>
      (channel === EVALUATION_CHANNELS.LIST_CASES ? items : { action: 'archive', id: 'x', file: 'x' }));
    render(<EvalCaseListTab />);

    const toggle = await screen.findByTestId('eval-case-matrix-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('eval-case-matrix')).toBeNull();
    // 1 行 × 6 列 = 6 格；红格 4（四契约列里 basic_tool 有数，其余 3 个 + 「其他」列）；未填 1/2
    expect(toggle.textContent).toContain('6 格 · 红格 4 · 未填 category 1/2');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('eval-case-matrix')).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('eval-case-matrix')).toBeNull();
  });

  it('题目表滚动容器不带上内边距，否则 sticky 表头上方留带子透出行（FB-162）', async () => {
    render(<EvalCaseListTab />);
    await screen.findByTestId('eval-case-row-daily-case');
    const scroller = screen.getByTestId('eval-case-list-scroll');
    expect(scroller.className).toContain('overflow-auto');
    expect(scroller.className).not.toMatch(/\bp[ty]-\d/);
  });

  it('题目表 sticky 表头：thead 与每个 th 都带底色，表头单元格 nowrap（FB-161）', async () => {
    render(<EvalCaseListTab />);
    const row = await screen.findByTestId('eval-case-row-daily-case');
    const thead = (row.closest('table') as HTMLTableElement).querySelector('thead') as HTMLTableSectionElement;
    // 底色不能只挂 thead：真机反馈里行文字透了上来，所以每个 th 也要自带底色
    expect(thead.className).toContain('sticky');
    expect(thead.className).toContain('z-10');
    expect(thead.className).toContain('bg-zinc-950');
    const headers = [...thead.querySelectorAll('th')];
    expect(headers).toHaveLength(9);
    expect(headers.every((th) => th.className.includes('bg-zinc-950'))).toBe(true);
    expect(headers.every((th) => th.className.includes('whitespace-nowrap'))).toBe(true);
    // 来源/状态/操作等窄列给最小宽度，否则表头被挤成逐字竖排
    expect(headers.slice(4).every((th) => /min-w-\d+/.test(th.className))).toBe(true);
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
