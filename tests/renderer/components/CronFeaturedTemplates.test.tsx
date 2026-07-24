// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

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

vi.mock('../../../src/renderer/components/features/cron/AutomationReviewInbox', () => ({
  AutomationReviewInbox: () => null,
}));

vi.mock('../../../src/renderer/components/features/cron/CronJobList', () => ({
  CronJobList: () => <div data-testid="cron-job-list" />,
}));

vi.mock('../../../src/renderer/components/features/cron/CronJobDetail', () => ({
  CronJobDetail: () => <div data-testid="cron-job-detail" />,
}));

vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({
  CronJobEditor: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import {
  CRON_TEMPLATES,
  FEATURED_CRON_TEMPLATES,
} from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput, formatActionSummary } from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const EXPECTED_SCHEDULES = {
  'daily-lookahead': { type: 'cron', expression: '0 15 * * 1-5', timezone: 'Asia/Shanghai' },
  'daily-review': { type: 'cron', expression: '30 17 * * 1-5', timezone: 'Asia/Shanghai' },
  'weekly-review': { type: 'cron', expression: '30 17 * * 4', timezone: 'Asia/Shanghai' },
} as const;

const FEATURED_IDS = Object.keys(EXPECTED_SCHEDULES);
const DELETED_TEMPLATE_IDS = [
  'db-backup',
  'api-health',
  'webhook-notify',
  'custom-script',
  'file-cleanup',
] as const;

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
  listJobs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('cowork cron templates', () => {
  it('只保留约定的 4 张模板，并移除旧开发运维模板 id', () => {
    const templateIds = CRON_TEMPLATES.map((template) => template.id);
    expect(templateIds).toEqual([
      'daily-lookahead',
      'daily-review',
      'weekly-review',
      'web-change-watch',
    ]);
    for (const id of DELETED_TEMPLATE_IDS) {
      expect(templateIds).not.toContain(id);
    }
    expect(templateIds).not.toContain('web-scrape');
  });

  it.each(FEATURED_IDS)('%s 无必填字段，且生成 agent job 和预期排期', (id) => {
    const template = CRON_TEMPLATES.find((item) => item.id === id);
    expect(template).toBeDefined();
    expect(template?.fields.some((field) => field.required === true)).toBe(false);

    const draft = template!.generate({});
    expect(draft.actionType).toBe('agent');
    expect(draft.agentType).toBe('default');

    const input = buildCronJobInput(draft);
    expect(input.action.type).toBe('agent');
    expect(input.scheduleType).toBe('cron');
    expect(input.schedule).toEqual(EXPECTED_SCHEDULES[id as keyof typeof EXPECTED_SCHEDULES]);
  });

  it('网页更新模板仅要求网页地址，并生成 agent job', () => {
    const template = CRON_TEMPLATES.find((item) => item.id === 'web-change-watch');
    expect(template?.fields).toEqual([
      expect.objectContaining({ key: 'url', required: true }),
      expect.objectContaining({ key: 'schedule' }),
    ]);
    expect(template?.fields.some((field) => field.key === 'output')).toBe(false);

    const draft = template!.generate({
      url: 'https://example.com/notice',
      schedule: '每天 10:30',
    });
    expect(draft.actionType).toBe('agent');
    expect(draft.shellCommand).toBe('');
    expect(buildCronJobInput(draft)).toMatchObject({
      schedule: {
        type: 'cron',
        expression: '30 10 * * *',
        timezone: 'Asia/Shanghai',
      },
      action: {
        type: 'agent',
        agentType: 'default',
      },
    });
  });
});

describe('任务列表摘要不漏开发者字串', () => {
  it('agent 型任务显示提示词本身，而不是 agentType 标签', () => {
    const template = FEATURED_CRON_TEMPLATES.find((item) => item.id === 'daily-lookahead');
    if (!template) throw new Error('daily-lookahead template missing');
    const input = buildCronJobInput(template.generate({}));
    const job = { ...input, id: 'j1', createdAt: 1, updatedAt: 1 } as CronJobDefinition;

    const summary = formatActionSummary(job);
    // agentType 是自由文本标签，渲染它会在 cowork 界面里种出 "default agent" 这种字串
    expect(summary).not.toContain('agent');
    expect(summary).toBe(job.action.type === 'agent' ? job.action.prompt : summary);
  });
});

describe('CronCenterPanel featured templates', () => {
  it('打开面板就能看到三张推荐卡', () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    expect(screen.getByTestId('cron-featured-templates')).toBeTruthy();
    expect(FEATURED_CRON_TEMPLATES.map((template) => template.id)).toEqual(FEATURED_IDS);
    for (const id of FEATURED_IDS) {
      expect(screen.getByTestId(`cron-featured-${id}`)).toBeTruthy();
    }
  });

  it('点一次推荐卡就直接创建启用的 agent job', async () => {
    createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'created-daily-lookahead',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));

    render(<CronCenterPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('cron-featured-daily-lookahead'));

    await waitFor(() => {
      expect(createJob).toHaveBeenCalledTimes(1);
    });
    const submitted = createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.enabled).toBe(true);
    expect(submitted.action.type).toBe('agent');
    expect(submitted.schedule).toEqual(EXPECTED_SCHEDULES['daily-lookahead']);
  });
});
