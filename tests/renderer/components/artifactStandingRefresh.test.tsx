// @vitest-environment jsdom
// N-ARTIFACT-STANDING-REFRESH：常设刷新入口组件——
// ① 弹窗保存走 cron createJob/updateJob 且 payload 由 buildStandingRefreshJobInput 构建；
// ② lastRefreshFailed 在场时 chip 转警示态（文案说明已保留上一版）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const domainInvoke = vi.hoisted(() => vi.fn());

const cronCalls = vi.hoisted(() => ({
  createJob: vi.fn().mockResolvedValue({ id: 'job-new' }),
  updateJob: vi.fn().mockResolvedValue({ id: 'job-existing' }),
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: cronCalls,
}));

import { ArtifactStandingRefresh } from '../../../src/renderer/components/ArtifactStandingRefresh';
import { buildStandingRefreshJobInput } from '@shared/artifactStandingRefresh';

function publishInfoResponse(data: Record<string, unknown>) {
  return { success: true, data };
}

function mockPublishInfo(standingRefresh?: Record<string, unknown>) {
  domainInvoke.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'getPublishInfo') {
      return publishInfoResponse({
        publishState: { kind: 'draft' },
        publishedVersions: [],
        ...(standingRefresh ? { standingRefresh } : {}),
      });
    }
    throw new Error(`unexpected workspace action: ${action}`);
  });
}

beforeEach(() => {
  (window as unknown as { domainAPI: unknown }).domainAPI = { invoke: domainInvoke };
  mockPublishInfo();
});

afterEach(() => {
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  domainInvoke.mockReset();
  cronCalls.createJob.mockClear();
  cronCalls.updateJob.mockClear();
  cleanup();
});

describe('ArtifactStandingRefresh 弹窗保存', () => {
  it('无既有任务：保存调 createJob，payload 等于 buildStandingRefreshJobInput 的输出', async () => {
    render(<ArtifactStandingRefresh filePath="/tmp/wt/weekly-report.json" />);
    await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));

    fireEvent.click(screen.getByTestId('artifact-standing-refresh-chip'));
    const textarea = await screen.findByPlaceholderText(/汇总本周进展/);
    fireEvent.change(textarea, { target: { value: 'Refresh weekly numbers' } });
    fireEvent.click(screen.getByText('每周'));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(cronCalls.createJob).toHaveBeenCalledTimes(1));
    expect(cronCalls.updateJob).not.toHaveBeenCalled();
    const input = cronCalls.createJob.mock.calls[0][0];
    expect(input).toEqual(
      buildStandingRefreshJobInput(
        { path: '/tmp/wt/weekly-report.json', instruction: 'Refresh weekly numbers', cadence: 'weekly' },
        '/tmp/wt',
      ),
    );
    // 关键字段直接核一遍，读测试不需要反推 builder
    expect(input.metadata.artifactRefresh.path).toBe('/tmp/wt/weekly-report.json');
    expect(input.schedule).toEqual({ type: 'cron', expression: '0 9 * * 1' });
    expect(input.tags).toContain('artifact-refresh');
  });

  it('已有任务（standingRefresh.jobId）：保存改走 updateJob 并带回原 jobId', async () => {
    mockPublishInfo({
      jobId: 'job-existing',
      enabled: true,
      cadence: 'daily',
      instruction: '旧指令',
      lastRunAt: 111,
    });
    render(<ArtifactStandingRefresh filePath="/tmp/wt/weekly-report.json" />);
    await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));

    fireEvent.click(screen.getByTestId('artifact-standing-refresh-chip'));
    // 编辑态回填旧指令
    await waitFor(() => screen.getByDisplayValue('旧指令'));
    fireEvent.change(screen.getByDisplayValue('旧指令'), { target: { value: '新指令' } });
    fireEvent.click(screen.getByText('每小时'));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(cronCalls.updateJob).toHaveBeenCalledTimes(1));
    expect(cronCalls.createJob).not.toHaveBeenCalled();
    expect(cronCalls.updateJob.mock.calls[0][0]).toBe('job-existing');
    expect(cronCalls.updateJob.mock.calls[0][1].metadata.artifactRefresh).toMatchObject({
      path: '/tmp/wt/weekly-report.json',
      instruction: '新指令',
      cadence: 'hourly',
    });
  });

  it('保存失败：显示人话错误，不抛原始 IPC 文本', async () => {
    cronCalls.createJob.mockRejectedValueOnce(new Error('IPC blew up with raw stack'));
    render(<ArtifactStandingRefresh filePath="/tmp/wt/weekly-report.json" />);
    await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));

    fireEvent.click(screen.getByTestId('artifact-standing-refresh-chip'));
    fireEvent.change(await screen.findByPlaceholderText(/汇总本周进展/), { target: { value: 'do it' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => screen.getByTestId('standing-refresh-save-error'));
    expect(screen.getByTestId('standing-refresh-save-error').textContent).not.toContain('IPC blew up');
  });
});

describe('ArtifactStandingRefresh chip 状态', () => {
  it('无任务时是设置入口；有任务时显示节奏', async () => {
    const { unmount } = render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);
    await waitFor(() => expect(screen.getByTestId('artifact-standing-refresh-chip').textContent).toContain('设置自动更新'));
    unmount();

    mockPublishInfo({ jobId: 'job-1', enabled: true, cadence: 'daily', instruction: 'x' });
    render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);
    await waitFor(() => expect(screen.getByTestId('artifact-standing-refresh-chip').textContent).toContain('自动更新'));
    expect(screen.getByTestId('artifact-standing-refresh-chip').textContent).toContain('每天');
  });

  it('lastRefreshFailed 在场：chip 转警示态，文案说明已保留上一版与失败时间', async () => {
    mockPublishInfo({
      jobId: 'job-1',
      enabled: true,
      cadence: 'daily',
      instruction: 'x',
      lastRefreshFailed: { at: Date.UTC(2026, 9, 4, 1, 2, 3), reason: 'agent run failed: boom' },
    });
    render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);

    const chip = await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));
    expect(chip.textContent).toContain('更新失败');
    expect(chip.textContent).toContain('已保留上一版');
    // 原因属工程细节：进 tooltip，不进可见文案
    expect(chip.textContent).not.toContain('boom');
    expect(chip.getAttribute('title')).toContain('boom');
  });
});
