// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { MCPServerStateSummary } from '../../../src/renderer/hooks/useMcpServerStates';

const createJob = vi.fn();
const listJobs = vi.fn().mockResolvedValue([]);

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: (...args: unknown[]) => listJobs(...args),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    createJob: (input: unknown) => createJob(input),
    updateJob: vi.fn(),
  },
}));

let mockMcpServerStates: MCPServerStateSummary[] = [];
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mockMcpServerStates,
}));

vi.mock('../../../src/renderer/components/features/cron/cronTemplates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/components/features/cron/cronTemplates')>();
  const { createDefaultCronJobDraft } = await import('../../../src/renderer/components/features/cron/types');
  const larkTemplate = {
    id: 'test-lark-template',
    name: '测试飞书模板',
    emoji: '🧪',
    description: '测试用飞书依赖模板',
    scheduleLabel: '每天 09:00',
    featured: true,
    fields: [],
    requiredConnectors: ['lark'],
    generate: () => ({
      ...createDefaultCronJobDraft(),
      name: '测试飞书模板',
      actionType: 'agent' as const,
      agentType: 'default',
      agentPrompt: '测试用',
    }),
  };
  return {
    ...actual,
    FEATURED_CRON_TEMPLATES: [...actual.FEATURED_CRON_TEMPLATES, larkTemplate],
  };
});

import { CronFeaturedTemplates } from '../../../src/renderer/components/features/cron/CronFeaturedTemplates';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const openSettingsTab = vi.fn();

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
  });
  useAppStore.setState({ openSettingsTab });
  listJobs.mockResolvedValue([]);
  mockMcpServerStates = [];
  openSettingsTab.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('模板卡连接器状态三态渲染', () => {
  it('无依赖的模板不渲染连接器状态点', () => {
    render(<CronFeaturedTemplates />);
    expect(screen.queryByTestId('cron-featured-daily-lookahead-connectors')).toBeNull();
  });

  it('依赖已连接：状态点显示已连接', () => {
    mockMcpServerStates = [
      {
        config: { name: 'lark', type: 'stdio', enabled: true },
        status: 'connected',
        toolCount: 3,
        resourceCount: 0,
      },
    ];
    render(<CronFeaturedTemplates />);
    const connectorRow = screen.getByTestId('cron-featured-test-lark-template-connectors');
    expect(connectorRow.textContent).toContain('飞书');
    expect(connectorRow.textContent).toContain('已连接');
  });

  it('依赖未连接：状态点显示未连接', () => {
    mockMcpServerStates = [];
    render(<CronFeaturedTemplates />);
    const connectorRow = screen.getByTestId('cron-featured-test-lark-template-connectors');
    expect(connectorRow.textContent).toContain('飞书');
    expect(connectorRow.textContent).toContain('未连接');
  });
});

describe('gateHint：未连接时点击不禁用，给出指名提示 + 跳转能力中心', () => {
  it('点击未连接依赖的模板：按钮未被禁用，仍会创建任务，并显示 gateHint', async () => {
    mockMcpServerStates = [];
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'created-test-lark-template',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));

    render(<CronFeaturedTemplates />);
    const button = screen.getByTestId('cron-featured-test-lark-template') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => {
      expect(createJob).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText(/需要先连接 飞书/)).toBeTruthy();
    const connectAction = screen.getByText('去连接');
    fireEvent.click(connectAction);
    expect(openSettingsTab).toHaveBeenCalledWith('mcp');
  });

  it('点击已连接依赖的模板：不显示 gateHint', async () => {
    mockMcpServerStates = [
      {
        config: { name: 'lark', type: 'stdio', enabled: true },
        status: 'connected',
        toolCount: 3,
        resourceCount: 0,
      },
    ];
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'created-test-lark-template',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));

    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-test-lark-template'));

    await waitFor(() => {
      expect(createJob).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText(/需要先连接/)).toBeNull();
  });
});
