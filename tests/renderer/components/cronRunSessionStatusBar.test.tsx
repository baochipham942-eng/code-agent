// @vitest-environment jsdom
// N-UI-CRON-RUN-RECORD-CLEAR：定时任务运行记录的状态行。
// 判定纯函数逐状态钉死；组件用真 store + 打桩服务验证四种状态一眼可分、
// 批准/拒绝走停车审批 IPC、再跑一次走 triggerJob、执行记录缺失不显示运行中。

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const getExecutionsMock = vi.hoisted(() => vi.fn());
const listParkedApprovalsMock = vi.hoisted(() => vi.fn());
const triggerJobMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock, invokeDomain: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { getExecutions: getExecutionsMock, getRecentExecutions: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: { listParkedApprovals: listParkedApprovalsMock },
}));

import { CronRunSessionStatusBar } from '../../../src/renderer/components/features/chat/CronRunSessionStatusBar';
import { CronRunSessionIntro } from '../../../src/renderer/components/features/chat/CronRunSessionIntro';
import {
  composeElapsed,
  deriveCronRunStatusLine,
  splitElapsedParts,
} from '../../../src/renderer/components/features/chat/cronRunSessionStatus';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import type { CronJobExecution } from '../../../src/shared/contract/cron';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

function makeExecution(overrides: Partial<CronJobExecution>): CronJobExecution {
  return {
    id: 'exec-1',
    jobId: 'job-1',
    status: 'running',
    scheduledAt: 1_000,
    startedAt: 2_000,
    retryAttempt: 0,
    sessionId: 'session-1',
    ...overrides,
  };
}

function showSession(session: Partial<SessionWithMeta> & { id: string }): void {
  useSessionStore.setState({
    sessions: [session as SessionWithMeta],
    currentSessionId: session.id,
    messages: [],
  });
}

const cronRunSession: Partial<SessionWithMeta> & { id: string } = {
  id: 'session-1',
  title: '[Schedule] 每日日程检查',
  readOnly: true,
  origin: { kind: 'cron', id: 'job-1', name: '每日日程检查' },
  sourceRunId: 'exec-1',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 2,
  turnCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue({ outcome: 'delivered' });
  getExecutionsMock.mockResolvedValue([]);
  listParkedApprovalsMock.mockResolvedValue([]);
  useCronStore.setState({ triggerJob: triggerJobMock as never });
  triggerJobMock.mockResolvedValue({ id: 'exec-2' });
});

afterEach(() => {
  cleanup();
  // 撤掉定时器相关的挂载残留
  vi.restoreAllMocks();
});

describe('deriveCronRunStatusLine（纯判定）', () => {
  it('等批准压过一切：有 pending 审批时即使是 running 也显示等批准', () => {
    const line = deriveCronRunStatusLine({
      execution: makeExecution({ status: 'running' }),
      pendingApproval: { id: 'req-1', requestedAt: 3_000 },
    });
    expect(line).toEqual({ kind: 'awaiting', approval: { id: 'req-1', requestedAt: 3_000 } });
  });

  it('running 取 startedAt，缺.startedAt 回落 scheduledAt', () => {
    expect(deriveCronRunStatusLine({ execution: makeExecution({ status: 'running' }), pendingApproval: null }))
      .toEqual({ kind: 'running', startedAt: 2_000 });
    expect(deriveCronRunStatusLine({ execution: makeExecution({ status: 'pending', startedAt: undefined }), pendingApproval: null }))
      .toEqual({ kind: 'running', startedAt: 1_000 });
  });

  it('completed 优先读 duration，缺了用 completedAt-startedAt 计算', () => {
    expect(deriveCronRunStatusLine({ execution: makeExecution({ status: 'completed', duration: 3_200 }), pendingApproval: null }))
      .toEqual({ kind: 'finished', durationMs: 3_200 });
    expect(deriveCronRunStatusLine({
      execution: makeExecution({ status: 'completed', duration: undefined, completedAt: 9_000 }),
      pendingApproval: null,
    })).toEqual({ kind: 'finished', durationMs: 7_000 });
  });

  it('进程没了/失败/取消都是「已中断」：dead run 绝不显示运行中', () => {
    for (const status of ['interrupted', 'failed', 'cancelled'] as const) {
      expect(deriveCronRunStatusLine({ execution: makeExecution({ status }), pendingApproval: null }))
        .toEqual({ kind: 'interrupted' });
    }
  });

  it('没有执行记录也没有等批准：不编状态（null）', () => {
    expect(deriveCronRunStatusLine({ execution: null, pendingApproval: null })).toBeNull();
  });

  it('流逝时间拆件与拼装：秒 / 分秒 / 时分（单位词来自 i18n）', () => {
    const zh = { hm: '{h} 时 {m} 分', ms: '{m} 分 {s} 秒', s: '{s} 秒' };
    expect(composeElapsed(splitElapsedParts(0), zh)).toBe('0 秒');
    expect(composeElapsed(splitElapsedParts(12_400), zh)).toBe('12 秒');
    expect(composeElapsed(splitElapsedParts(63_000), zh)).toBe('1 分 3 秒');
    expect(composeElapsed(splitElapsedParts(3_780_000), zh)).toBe('1 时 3 分');
  });
});

describe('CronRunSessionStatusBar（组件）', () => {
  it('运行中：呼吸点状态行带流逝时间，没有批准/重跑按钮', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'running', startedAt: Date.now() - 12_000 })]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('running');
    expect(screen.getByTestId('cron-run-status-text').textContent).toContain('正在运行');
    // 拉取到渲染有几毫秒延迟，12.x 秒地板值可能翻到 13——两个都算对（钉的是「有流逝秒数」）
    expect(screen.getByTestId('cron-run-status-text').textContent).toMatch(/已 1[23] 秒/);
    expect(screen.queryByTestId('cron-run-status-approve')).toBeNull();
    expect(screen.queryByTestId('cron-run-status-rerun')).toBeNull();
  });

  it('等批准：显示在干什么 + 批准走停车审批 IPC（first-responder-wins 同链路）', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'running' })]);
    listParkedApprovalsMock.mockResolvedValue([{
      id: 'req-1',
      kind: 'tool_approval',
      sessionId: 'session-1',
      tool: 'bash',
      displayTool: '运行命令',
      requestedAt: Date.now() - 5_000,
      status: 'pending',
      argsPreview: 'echo BG-PARKED-888',
    }]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('awaiting');
    expect(screen.getByTestId('cron-run-status-text').textContent).toContain('等你批准');
    expect(screen.getByTestId('cron-run-status-text').textContent).toContain('echo BG-PARKED-888');

    fireEvent.click(screen.getByTestId('cron-run-status-approve'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-1', 'allow', 'session-1');
    });

    fireEvent.click(screen.getByTestId('cron-run-status-reject'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-1', 'deny', 'session-1');
    });
  });

  it('非 pending（orphaned/voided）的停车审批不算等批准', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'interrupted' })]);
    listParkedApprovalsMock.mockResolvedValue([{
      id: 'req-1', sessionId: 'session-1', tool: 'bash', requestedAt: 1, status: 'voided',
    }]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('interrupted');
  });

  it('已中断：显示「已中断，没有结果」+ 再跑一次走 triggerJob', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'interrupted' })]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('interrupted');
    expect(screen.getByTestId('cron-run-status-text').textContent).toBe('已中断，没有结果');

    fireEvent.click(screen.getByTestId('cron-run-status-rerun'));
    await waitFor(() => {
      expect(triggerJobMock).toHaveBeenCalledWith('job-1');
    });
  });

  it('已完成：显示用时', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'completed', duration: 3_000, completedAt: 5_000 })]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('finished');
    expect(screen.getByTestId('cron-run-status-text').textContent).toBe('已完成 · 用时 3 秒');
  });

  it('执行记录找不到（run gone）：不渲染任何状态行，绝不显示运行中', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([]);
    const { container } = render(<CronRunSessionStatusBar sessionId="session-1" />);
    // 初次拉取完成后仍无状态可讲
    await waitFor(() => expect(getExecutionsMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="cron-run-status"]')).toBeNull();
  });

  it('sourceRunId 缺席的老会话按 sessionId 关联执行记录', async () => {
    showSession({ ...cronRunSession, sourceRunId: undefined });
    getExecutionsMock.mockResolvedValue([makeExecution({ id: 'other-exec', sessionId: 'session-1', status: 'completed', duration: 1_000 })]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('finished');
  });

  it('非 cron/heartbeat 会话不渲染状态行', async () => {
    showSession({ ...cronRunSession, origin: { kind: 'manual' } });
    const { container } = render(<CronRunSessionStatusBar sessionId="session-1" />);
    await waitFor(() => expect(getExecutionsMock).not.toHaveBeenCalled());
    expect(container.querySelector('[data-testid="cron-run-status"]')).toBeNull();
  });
});

describe('CronRunSessionIntro（来源小标）', () => {
  it('cron/heartbeat 运行记录显示「定时任务自动运行」', () => {
    showSession(cronRunSession);
    render(<CronRunSessionIntro sessionId="session-1" />);
    expect(screen.getByTestId('cron-run-intro-label').textContent).toBe('定时任务自动运行');
  });

  it('heartbeat 会话同样显示；普通会话不显示', () => {
    showSession({ ...cronRunSession, origin: { kind: 'heartbeat', id: 'hb-1' } });
    const { rerender } = render(<CronRunSessionIntro sessionId="session-1" />);
    expect(screen.getByTestId('cron-run-intro-label')).toBeTruthy();
    showSession({ ...cronRunSession, origin: { kind: 'manual' } });
    rerender(<CronRunSessionIntro sessionId="session-1" />);
    expect(screen.queryByTestId('cron-run-intro-label')).toBeNull();
  });
});
