// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerStateSummary } from '../../../src/renderer/hooks/useMcpServerStates';

let mockMcpServerStates: MCPServerStateSummary[] = [];
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mockMcpServerStates,
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
  mockMcpServerStates = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openTemplatePicker() {
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('从模板创建'));
}

describe('模板选择步骤：真实飞书模板的连接器状态点', () => {
  it('未连接 lark 时，两张飞书模板卡都显示未连接，其余模板不显示状态点', () => {
    openTemplatePicker();

    const calendarCard = screen.getByText('飞书日程冲突监听').closest('button');
    const tableCard = screen.getByText('飞书表格行变更监听').closest('button');
    const dailyCard = screen.getByText('每日前瞻').closest('button');

    expect(calendarCard?.textContent).toContain('飞书');
    expect(tableCard?.textContent).toContain('飞书');
    // 无依赖模板不应该出现任何连接器 pill 文案
    expect(dailyCard?.textContent).not.toContain('飞书');
  });

  it('已连接 lark 时，两张飞书模板卡不再是灰点（emerald 状态类名出现）', () => {
    mockMcpServerStates = [
      {
        config: { name: 'lark', type: 'stdio', enabled: true },
        status: 'connected',
        toolCount: 6,
        resourceCount: 0,
      },
    ];
    openTemplatePicker();

    const calendarCard = screen.getByText('飞书日程冲突监听').closest('button');
    expect(calendarCard?.querySelector('.text-emerald-300')).toBeTruthy();
  });
});
