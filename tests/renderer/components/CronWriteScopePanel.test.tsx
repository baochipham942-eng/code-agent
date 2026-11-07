// @vitest-environment jsdom
// ============================================================================
// 任务详情「文件写入授权」面板三态（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ④）：
// 已授权（根 + 撤销）/ 未授权可解析（允许按钮带文件夹）/ 未授权无文件夹（提示、无按钮）。
// 授权点击走 cronClient.grantWriteScope，成功后 store 内联更新、面板翻到已授权态。
// ============================================================================
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    grantWriteScope: vi.fn(),
    revokeWriteScope: vi.fn(),
  },
  default: {
    grantWriteScope: vi.fn(),
    revokeWriteScope: vi.fn(),
  },
}));

import { CronWriteScopePanel } from '../../../src/renderer/components/features/cron/CronWriteScopePanel';
import cronClient from '../../../src/renderer/services/cronClient';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const FOLDER = '/Users/worker/notes';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-1',
    name: '每日笔记',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: '写一条笔记',
      context: { sourceSessionId: 'src-sess' },
    },
    runsOn: 'local',
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useCronStore.setState({ jobs: [] });
  useSessionStore.setState({ sessions: [] });
  vi.mocked(cronClient.grantWriteScope).mockReset();
  vi.mocked(cronClient.revokeWriteScope).mockReset();
});

afterEach(() => {
  cleanup();
  useCronStore.setState({ jobs: [] });
  useSessionStore.setState({ sessions: [] });
});

describe('CronWriteScopePanel 三态', () => {
  it('未授权 + 来源会话可解析：允许按钮带文件夹；点击授权成功后翻到已授权态并更新 store', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'src-sess', title: '来源', workingDirectory: FOLDER } as never],
    });
    const job = makeJob();
    useCronStore.setState({ jobs: [job] });
    const grantedJob = { ...job, metadata: { writeGrantRoot: FOLDER } };
    vi.mocked(cronClient.grantWriteScope).mockResolvedValue(grantedJob);

    render(<CronWriteScopePanel job={job} />);
    expect(screen.getByTestId('cron-write-scope-denied').textContent).toContain('需要保存文件时会停下来等你确认');
    const allow = screen.getByTestId('cron-write-scope-allow');
    expect(allow.textContent).toContain(FOLDER);

    const { rerender } = render(<CronWriteScopePanel job={job} />);
    await act(async () => { fireEvent.click(allow); });
    expect(cronClient.grantWriteScope).toHaveBeenCalledWith('job-1');
    expect(useCronStore.getState().jobs[0].metadata?.writeGrantRoot).toBe(FOLDER);
    // 真实链路里 CronCenterPanel 从 store 重取 selectedJob 再喂回面板；单测里用 rerender 等价复刻
    rerender(<CronWriteScopePanel job={grantedJob} />);
    expect(screen.getByTestId('cron-write-scope-granted').textContent).toContain(FOLDER);
  });

  it('常设刷新任务：无来源会话也按产物目录给允许按钮（与 host 授权解析同源）', () => {
    const job = makeJob({
      action: { type: 'agent', agentType: 'default', prompt: '刷新报告' },
      metadata: { artifactRefresh: { path: `${FOLDER}/report.md`, instruction: '刷新', cadence: 'daily' } },
    });
    render(<CronWriteScopePanel job={job} />);
    expect(screen.getByTestId('cron-write-scope-allow').textContent).toContain(FOLDER);
  });

  it('已授权：显示授权根 + 撤销按钮；点击撤销后回到未授权态', async () => {
    const job = makeJob({ metadata: { writeGrantRoot: FOLDER } });
    useCronStore.setState({ jobs: [job] });
    vi.mocked(cronClient.revokeWriteScope).mockResolvedValue({ ...job, metadata: undefined });

    render(<CronWriteScopePanel job={job} />);
    expect(screen.getByTestId('cron-write-scope-granted').textContent).toContain(FOLDER);
    expect(screen.queryByTestId('cron-write-scope-allow')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId('cron-write-scope-revoke')); });
    expect(cronClient.revokeWriteScope).toHaveBeenCalledWith('job-1');
    await waitFor(() => {
      expect(useCronStore.getState().jobs[0].metadata).toBeUndefined();
    });
  });

  it('未授权 + 解析不出文件夹：提示先在对话里选工作文件夹，不出按钮', () => {
    const job = makeJob({ action: { type: 'agent', agentType: 'default', prompt: '写一条笔记' } });
    render(<CronWriteScopePanel job={job} />);
    expect(screen.getByTestId('cron-write-scope-no-folder').textContent).toContain('先在对话里给这个任务选一个工作文件夹');
    expect(screen.queryByTestId('cron-write-scope-allow')).toBeNull();
    expect(screen.queryByTestId('cron-write-scope-revoke')).toBeNull();
  });

  it('授权点击被 host 拒（无文件夹）时切到提示态，不出死按钮', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'src-sess', title: '来源', workingDirectory: FOLDER } as never],
    });
    const job = makeJob();
    vi.mocked(cronClient.grantWriteScope).mockRejectedValue(new Error('CRON_WRITE_SCOPE_NO_FOLDER'));

    render(<CronWriteScopePanel job={job} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cron-write-scope-allow')); });
    expect(screen.getByTestId('cron-write-scope-no-folder').textContent).toContain('先在对话里给这个任务选一个工作文件夹');
    expect(screen.queryByTestId('cron-write-scope-allow')).toBeNull();
  });

  it('会话列表后补页时候选文件夹跟着出现（订阅而非快照）', async () => {
    const job = makeJob();
    render(<CronWriteScopePanel job={job} />);
    expect(screen.getByTestId('cron-write-scope-no-folder')).toBeTruthy();

    await act(async () => {
      useSessionStore.setState({
        sessions: [{ id: 'src-sess', title: '来源', workingDirectory: FOLDER } as never],
      });
    });
    expect(screen.getByTestId('cron-write-scope-allow').textContent).toContain(FOLDER);
  });
});
