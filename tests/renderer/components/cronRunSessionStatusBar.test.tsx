// @vitest-environment jsdom
// N-UI-CRON-RUN-RECORD-CLEAR：定时任务运行记录的状态行。
// 判定纯函数逐状态钉死；组件用真 store + 打桩服务验证四种状态一眼可分、
// 批准/拒绝走停车审批 IPC、再跑一次走 triggerJob、执行记录缺失不显示运行中。

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const getExecutionsMock = vi.hoisted(() => vi.fn());
const listParkedApprovalsMock = vi.hoisted(() => vi.fn());
const triggerJobMock = vi.hoisted(() => vi.fn());
const toastInfoMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));
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
  clearObservedCronRunStatusForSession,
  composeElapsed,
  deriveCronRunStatusLine,
  getObservedCronRunStatusForSession,
  setObservedCronRunStatusForSession,
  splitElapsedParts,
} from '../../../src/renderer/components/features/chat/cronRunSessionStatus';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import type { CronJobExecution } from '../../../src/shared/contract/cron';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

// 状态点的 class 必须是 global.css 里真定义的（review r6：cron-run-status-dot--pulsing 全仓无定义）。
// jsdom 环境下 import.meta.url 不是 file://，用仓根相对路径读。
const globalCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

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
  setObservedCronRunStatusForSession('session-1', null);
  invokeMock.mockResolvedValue({ outcome: 'delivered' });
  getExecutionsMock.mockResolvedValue([]);
  listParkedApprovalsMock.mockResolvedValue([]);
  useCronStore.setState({ triggerJob: triggerJobMock as never });
  triggerJobMock.mockResolvedValue({ id: 'exec-2' });
});

afterEach(() => {
  cleanup();
  clearObservedCronRunStatusForSession('session-1');
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

  it('interrupted / failed（被拒 vs 其他） / cancelled 各自拆成独立 kind，绝不混成同一个', () => {
    expect(deriveCronRunStatusLine({ execution: makeExecution({ status: 'interrupted' }), pendingApproval: null }))
      .toEqual({ kind: 'interrupted' });
    expect(deriveCronRunStatusLine({ execution: makeExecution({ status: 'cancelled' }), pendingApproval: null }))
      .toEqual({ kind: 'cancelled' });
    expect(deriveCronRunStatusLine({
      execution: makeExecution({ status: 'failed', error: 'Permission denied by user' }),
      pendingApproval: null,
    })).toEqual({ kind: 'failed-denied' });
    expect(deriveCronRunStatusLine({
      execution: makeExecution({ status: 'failed', error: '用户拒绝了该命令' }),
      pendingApproval: null,
    })).toEqual({ kind: 'failed-denied' });
    expect(deriveCronRunStatusLine({
      execution: makeExecution({ status: 'failed', error: 'bash 被自动拒绝：当前无人值守会话不允许弹权限框' }),
      pendingApproval: null,
    })).toEqual({ kind: 'failed-denied' });
    expect(deriveCronRunStatusLine({
      execution: makeExecution({ status: 'failed', error: 'Command failed with exit code 1: ECONNRESET' }),
      pendingApproval: null,
    })).toEqual({ kind: 'failed-generic' });
    expect(deriveCronRunStatusLine({
      execution: makeExecution({ status: 'failed', error: undefined }),
      pendingApproval: null,
    })).toEqual({ kind: 'failed-generic' });
  });

  it('权限拒绝错误识别：稳定识别主进程权限拒绝错误，不把普通失败误判为被拒', () => {
    const statusForError = (error: string | undefined) =>
      deriveCronRunStatusLine({ execution: makeExecution({ status: 'failed', error }), pendingApproval: null })?.kind;

    expect(statusForError('Permission denied by user')).toBe('failed-denied');
    expect(statusForError('PERMISSION_DENIED_BY_USER')).toBe('failed-denied');
    expect(statusForError('PERMISSION_DENIED_UNATTENDED_AUTO')).toBe('failed-denied');
    expect(statusForError('用户拒绝了该命令')).toBe('failed-denied');
    expect(statusForError('命令被拒绝')).toBe('failed-denied');
    expect(statusForError('bash 被自动拒绝：危险命令在无人值守模式下禁止执行')).toBe('failed-denied');
    expect(statusForError('Command was denied by policy')).toBe('failed-denied');

    expect(statusForError(undefined)).toBe('failed-generic');
    expect(statusForError('')).toBe('failed-generic');
    expect(statusForError('Command failed: exit code 1')).toBe('failed-generic');
    expect(statusForError('429 Too Many Requests')).toBe('failed-generic');
    expect(statusForError('Execution timed out after 60000ms')).toBe('failed-generic');
  });

  it('裸 "Permission denied" 是 shell/文件系统权限错，不算「命令被拒绝」（review r6）', () => {
    const statusForError = (error: string) =>
      deriveCronRunStatusLine({ execution: makeExecution({ status: 'failed', error }), pendingApproval: null })?.kind;

    expect(statusForError('Permission denied')).toBe('failed-generic');
    expect(statusForError('bash: /Users/x/run.sh: Permission denied')).toBe('failed-generic');
    expect(statusForError('Error: spawn EACCES — Permission denied')).toBe('failed-generic');
  });

  it('UNATTENDED_APPROVAL_TIMEOUT 是无人批准超时（没人拒），归到没跑成而非命令被拒（review r6）', () => {
    const statusForError = (error: string) =>
      deriveCronRunStatusLine({ execution: makeExecution({ status: 'failed', error }), pendingApproval: null })?.kind;

    expect(statusForError('UNATTENDED_APPROVAL_TIMEOUT')).toBe('failed-generic');
    // host 真实全文（unattendedApprovalTerminal.ts）
    expect(statusForError('UNATTENDED_APPROVAL_TIMEOUT: 工具 bash 的审批等了 10 分钟仍无人批准（当前无人在场），已自动拒绝。'))
      .toBe('failed-generic');
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

  it('运行中：状态点的 class 在 global.css 里有真定义（呼吸动画 + reduced-motion 降级）（review r6）', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'running', startedAt: Date.now() })]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    const dot = node.querySelector('span[aria-hidden="true"]');
    expect(dot).toBeTruthy();
    const cronClasses = (dot as HTMLElement).className.split(/\s+/).filter((name) => name.startsWith('cron-run'));
    // 组件用的类必须是 CSS 里定义过的（曾用全仓无定义的 cron-run-status-dot--pulsing，点永不呼吸）
    expect(cronClasses).toEqual(['cron-run-pulse-dot']);
    expect(globalCss).toMatch(/\.cron-run-pulse-dot\s*\{[^}]*animation:\s*cronRunPulse/);
    expect(globalCss).toMatch(/@keyframes cronRunPulse/);
    // reduced-motion 降级分支保留：停动画
    expect(globalCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.cron-run-pulse-dot\s*\{\s*animation:\s*none/);
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

  // review r6：AGENT_PERMISSION_RESPONSE 的注册类型是 Promise<void>，但真实写点各不相同
  // （agent.ipc.ts legacy handler 回 {outcome}；web HTTP 桥送达解包、未送达透传
  // {success:false,error} 信封）。每个真实形状一测，stale 分支不许恒为假。
  describe('批准/拒绝的返回形状（按真实写点逐个钉死）', () => {
    const APPROVAL_STALE_COPY = '这条批准已经失效（发起它的运行已结束），已标记过期';
    const APPROVAL_FAILED_COPY = '操作没有生效，请重试';

    async function renderAwaitingApproval(): Promise<void> {
      showSession(cronRunSession);
      getExecutionsMock.mockResolvedValue([makeExecution({ status: 'running' })]);
      listParkedApprovalsMock.mockResolvedValue([{
        id: 'req-1', kind: 'tool_approval', sessionId: 'session-1', tool: 'bash',
        displayTool: '运行命令', requestedAt: Date.now() - 5_000, status: 'pending',
        argsPreview: 'echo BG-PARKED-888',
      }]);
      render(<CronRunSessionStatusBar sessionId="session-1" />);
      await screen.findByTestId('cron-run-status-approve');
    }

    it('Electron 式送达 {outcome:"delivered"}：不出声', async () => {
      invokeMock.mockResolvedValue({ outcome: 'delivered' });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(invokeMock).toHaveBeenCalled());
      expect(toastInfoMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('Electron 式未送达 {outcome:"unknown_request"}：出「已失效」toast 并立即刷新状态行', async () => {
      await renderAwaitingApproval();
      invokeMock.mockResolvedValue({ outcome: 'unknown_request' });
      // 点击后的刷新拉到终态：状态行不等下一拍轮询就变（review r6）
      getExecutionsMock.mockResolvedValue([makeExecution({ status: 'interrupted' })]);
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastInfoMock).toHaveBeenCalledWith(APPROVAL_STALE_COPY));
      await waitFor(() => {
        expect(screen.getByTestId('cron-run-status').dataset.state).toBe('interrupted');
      });
    });

    it('web HTTP 桥未送达信封 {success:false,error:{code:"PENDING_PERMISSION_NOT_FOUND"}}：出「已失效」toast', async () => {
      invokeMock.mockResolvedValue({
        success: false,
        error: { code: 'PENDING_PERMISSION_NOT_FOUND', message: 'Permission response not delivered (unknown_request)' },
      });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastInfoMock).toHaveBeenCalledWith(APPROVAL_STALE_COPY));
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('web HTTP 桥送达解包 {requestId,sessionId,source}（没有 outcome 字段）：不出声，绝不误报 stale', async () => {
      invokeMock.mockResolvedValue({ requestId: 'req-1', sessionId: 'session-1', source: 'task-manager' });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(invokeMock).toHaveBeenCalled());
      expect(toastInfoMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('web 停车审批经幸存行恢复 {outcome:"no_orchestrator",resumed:"executed"}：已执行，不出声，绝不误报 stale', async () => {
      invokeMock.mockResolvedValue({ requestId: 'req-1', sessionId: 'session-1', outcome: 'no_orchestrator', resumed: 'executed' });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(invokeMock).toHaveBeenCalled());
      expect(toastInfoMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('web 停车审批重启后作废 {outcome:"no_orchestrator",resumed:"closed"}：命令没跑，出「已失效」toast', async () => {
      invokeMock.mockResolvedValue({ requestId: 'req-1', sessionId: 'session-1', outcome: 'no_orchestrator', resumed: 'closed' });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastInfoMock).toHaveBeenCalledWith(APPROVAL_STALE_COPY));
    });

    it('web 停车审批恢复抢输 {outcome:"no_orchestrator",resumed:"lost_race"}：出「已失效」toast', async () => {
      invokeMock.mockResolvedValue({ requestId: 'req-1', sessionId: 'session-1', outcome: 'no_orchestrator', resumed: 'lost_race' });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastInfoMock).toHaveBeenCalledWith(APPROVAL_STALE_COPY));
    });

    it('Electron 式 {outcome:"storage_unavailable"}（宿主活着、台账写不进）：说「没生效请重试」，不说「已失效」', async () => {
      invokeMock.mockResolvedValue({ outcome: 'storage_unavailable' });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(APPROVAL_FAILED_COPY));
      expect(toastInfoMock).not.toHaveBeenCalled();
    });

    it('web HTTP 桥 {success:false,error:{code:"PENDING_APPROVAL_STORAGE_UNAVAILABLE"}}：同样按可重试出声', async () => {
      invokeMock.mockResolvedValue({
        success: false,
        error: { code: 'PENDING_APPROVAL_STORAGE_UNAVAILABLE', message: 'could not be recorded; retry' },
      });
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(APPROVAL_FAILED_COPY));
      expect(toastInfoMock).not.toHaveBeenCalled();
    });

    it('注册类型 Promise<void>（undefined，无信号）：不出声', async () => {
      invokeMock.mockResolvedValue(undefined);
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(invokeMock).toHaveBeenCalled());
      expect(toastInfoMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('host 裸 outcome 字符串非 delivered（agentAppService 直接回报）：出「已失效」toast', async () => {
      invokeMock.mockResolvedValue('unknown_request');
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastInfoMock).toHaveBeenCalledWith(APPROVAL_STALE_COPY));
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('host 裸 outcome 字符串 delivered：不出声', async () => {
      invokeMock.mockResolvedValue('delivered');
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(invokeMock).toHaveBeenCalled());
      expect(toastInfoMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('invoke 抛错（审批应答发送失败）：出「操作没有生效」toast，点击不是没反应', async () => {
      invokeMock.mockRejectedValue(new Error('审批应答发送失败 (502): bad gateway'));
      await renderAwaitingApproval();
      fireEvent.click(screen.getByTestId('cron-run-status-approve'));
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(APPROVAL_FAILED_COPY));
      expect(toastInfoMock).not.toHaveBeenCalled();
    });
  });

  it('状态行卸载时清掉观测 map：模块级 Map 不随打开过的记录会话一条条涨（review r6）', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'completed', duration: 1_000 })]);
    const { unmount } = render(<CronRunSessionStatusBar sessionId="session-1" />);
    await screen.findByTestId('cron-run-status');
    expect(getObservedCronRunStatusForSession('session-1')?.kind).toBe('finished');
    unmount();
    expect(getObservedCronRunStatusForSession('session-1')).toBeNull();
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

  it('失败（命令被拒绝）：显示「没跑成：命令被拒绝」+ 再跑一次走 triggerJob', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([
      makeExecution({ status: 'failed', error: 'Permission denied: 用户拒绝了该命令' }),
    ]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('failed-denied');
    expect(screen.getByTestId('cron-run-status-text').textContent).toBe('没跑成：命令被拒绝');

    fireEvent.click(screen.getByTestId('cron-run-status-rerun'));
    await waitFor(() => {
      expect(triggerJobMock).toHaveBeenCalledWith('job-1');
    });
  });

  it('失败（其他原因）：显示「没跑成」，绝不把裸 error 串吐到状态行 + 再跑一次走 triggerJob', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([
      makeExecution({ status: 'failed', error: 'Error: ECONNRESET socket hang up at TLSSocket' }),
    ]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('failed-generic');
    expect(screen.getByTestId('cron-run-status-text').textContent).toBe('没跑成');
    expect(screen.getByTestId('cron-run-status-text').textContent).not.toContain('ECONNRESET');

    fireEvent.click(screen.getByTestId('cron-run-status-rerun'));
    await waitFor(() => {
      expect(triggerJobMock).toHaveBeenCalledWith('job-1');
    });
  });

  it('已取消：显示「已取消」+ 再跑一次走 triggerJob', async () => {
    showSession(cronRunSession);
    getExecutionsMock.mockResolvedValue([makeExecution({ status: 'cancelled' })]);
    render(<CronRunSessionStatusBar sessionId="session-1" />);
    const node = await screen.findByTestId('cron-run-status');
    expect(node.dataset.state).toBe('cancelled');
    expect(screen.getByTestId('cron-run-status-text').textContent).toBe('已取消');

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
