// ============================================================================
// CronRunSessionStatusBar — 定时任务运行记录的状态行（N-UI-CRON-RUN-RECORD-CLEAR）
// ----------------------------------------------------------------------------
// 挂在运行记录会话第一条任务气泡下方（原型 role-wake-prototype-v2 屏四）：
//   运行中   呼吸点 + 「正在运行 · 已 N 秒」（每秒跳动，状态来自执行记录轮询）
//   等批准   「等你批准：<在干什么>」 + 批准 / 拒绝（复用停车审批 IPC，先到先得）
//   已中断   「已中断，没有结果」 + 再跑一次（复用 triggerJob，跑的是新一次运行）
//   已完成   「已完成 · 用时 N」
// 数据真源：cronClient.getExecutions（执行记录）+ listParkedApprovals（等批准）。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CronJobExecution } from '@shared/contract/cron';
import type { ParkedApprovalInboxItem } from '@shared/contract/pendingApproval';
import type { PermissionResponse } from '@shared/contract/permission';
import { IPC_CHANNELS } from '@shared/ipc';
import { Check, X } from 'lucide-react';
import { cronClient } from '../../../services/cronClient';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import ipcService from '../../../services/ipcService';
import { useCronStore } from '../../../stores/cronStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { classifyPermissionDelivery } from '../../PermissionDialog/permissionDelivery';
import {
  clearObservedCronRunStatusForSession,
  composeElapsed,
  deriveCronRunStatusLine,
  findCronExecutionForSession,
  isTerminalCronRunStatusKind,
  setObservedCronRunStatusForSession,
  splitElapsedParts,
  type CronRunAwaitingApproval,
  type CronRunStatusLine,
} from './cronRunSessionStatus';

/** 运行中/等批准才轮询；终态定格（再跑一次会开新会话，不会改写本记录）。 */
const POLL_INTERVAL_MS = 2000;

function awaitingLabelFromParked(item: ParkedApprovalInboxItem, bashRunPrefix: string): string | undefined {
  const preview = item.argsPreview?.trim();
  if (!item.displayTool && item.tool?.toLowerCase() === 'bash' && preview) {
    return `${bashRunPrefix}${preview}`;
  }
  const parts = [item.displayTool ?? item.tool, preview].filter(Boolean);
  return parts.length > 0 ? parts.join('：') : undefined;
}

function findParkedApprovalForSession(
  rows: ParkedApprovalInboxItem[] | undefined,
  sessionId: string,
  bashRunPrefix: string,
): CronRunAwaitingApproval | null {
  const pending = (rows ?? []).find((item) => item.sessionId === sessionId && item.status === 'pending');
  if (!pending) return null;
  return {
    id: pending.id,
    requestedAt: pending.requestedAt,
    label: awaitingLabelFromParked(pending, bashRunPrefix),
  };
}

export const CronRunSessionStatusBar: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n();
  const copy = t.cronRunRecord;
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const jobId = session?.origin?.kind === 'cron' || session?.origin?.kind === 'heartbeat'
    ? session.origin.id?.trim() || undefined
    : undefined;
  const executionId = session?.sourceRunId;
  const [execution, setExecution] = useState<CronJobExecution | null>(null);
  const [pendingApproval, setPendingApproval] = useState<CronRunAwaitingApproval | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);
  // 终态后停轮询：completed/interrupted/failed/cancelled 不会自己变回来。
  const status = useMemo(
    () => deriveCronRunStatusLine({ execution, pendingApproval }),
    [execution, pendingApproval],
  );
  useEffect(() => {
    setObservedCronRunStatusForSession(sessionId, status);
  }, [sessionId, status]);
  // 卸载时清掉本会话的观测值：模块级 Map 不随打开过的记录会话一条条涨。
  useEffect(() => {
    return () => { clearObservedCronRunStatusForSession(sessionId); };
  }, [sessionId]);
  const statusRef = useRef<CronRunStatusLine | null>(null);
  statusRef.current = status;
  // 找不到执行记录的连续次数：老会话缺 sourceRunId/sessionId 关联时别无限轮询。
  const missingFetchesRef = useRef(0);
  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      const executions = await cronClient.getExecutions(jobId, 20);
      const nextExecution = findCronExecutionForSession(executions, { executionId, sessionId });
      if (nextExecution) missingFetchesRef.current = 0;
      else missingFetchesRef.current += 1;
      setExecution(nextExecution);
      // 等批准列表只为 running 期间服务（等批准的运行 execution 必是 running）。
      if (nextExecution?.status === 'running') {
        const parked = await sessionAutomationClient.listParkedApprovals();
        setPendingApproval(findParkedApprovalForSession(parked, sessionId, copy.awaitingBashPrefix));
      } else {
        setPendingApproval((previous) => (nextExecution ? null : previous));
      }
    } catch {
      // 拉不到就不改状态：宁可停在上一拍的真实值，也不显示编出来的状态。
    }
  }, [copy.awaitingBashPrefix, executionId, jobId, sessionId]);

  const activeKind = status?.kind ?? null;
  useEffect(() => {
    if (!jobId) return;
    void refresh();
    if (isTerminalCronRunStatusKind(activeKind)) return;
    const timer = window.setInterval(() => {
      if (statusRef.current === null && missingFetchesRef.current >= 5) return;
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => { window.clearInterval(timer); };
    // activeKind 变化时重建定时器：进入终态撤轮询，回到运行态接上。
  }, [activeKind, jobId, refresh]);

  // 运行中的流逝时间每秒跳动（终态不挂定时器）。
  const runningStartedAt = status?.kind === 'running' ? status.startedAt : null;
  useEffect(() => {
    if (runningStartedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [runningStartedAt]);

  const handleApproval = useCallback(async (response: PermissionResponse) => {
    if (!pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      // 与待过目收件箱同一条链路（first-responder-wins）。返回值按真实形状收窄
      // （见 classifyPermissionDelivery）：已失效如实说「已失效」，台账写不进说
      // 「没生效，请重试」——不让点击看起来「没反应」。
      const result: unknown = await ipcService.invoke(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, pendingApproval.id, response, sessionId,
      );
      const delivery = classifyPermissionDelivery(result);
      if (delivery === 'stale') {
        toast.info(copy.approvalStale);
      } else if (delivery === 'retryable') {
        toast.error(copy.approvalFailed);
      }
    } catch {
      toast.error(copy.approvalFailed);
    } finally {
      setApprovalBusy(false);
      // stale/失败也要立即刷新：等批准多半已不在，别等下一拍轮询才变。
      void refresh();
    }
  }, [approvalBusy, copy.approvalFailed, copy.approvalStale, pendingApproval, refresh, sessionId]);

  const handleRerun = useCallback(async () => {
    if (!jobId || isRerunning) return;
    setIsRerunning(true);
    try {
      await useCronStore.getState().triggerJob(jobId);
    } catch {
      toast.error(copy.rerunFailed);
    } finally {
      setIsRerunning(false);
    }
  }, [copy.rerunFailed, isRerunning, jobId]);

  if (!jobId) return null;

  if (status?.kind === 'awaiting') {
    return (
      <div
        className="flex flex-wrap items-center gap-2 py-1 text-[13px] text-badge-warning"
        role="status"
        data-testid="cron-run-status"
        data-state="awaiting"
      >
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-mark-warning" aria-hidden="true" />
        <span data-testid="cron-run-status-text">
          {copy.awaiting}
          {status.approval.label ? `：${status.approval.label}` : ''}
        </span>
        <span className="flex items-center gap-1.5">
          <button /* ds-allow:button: 状态行内超小批准按钮（h-6 px-2 text-xs），Button primitive 最小 sm 档更高 */
            type="button"
            onClick={() => { void handleApproval('allow'); }}
            disabled={approvalBusy}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-badge-success/40 bg-emerald-500/10 px-2 text-xs text-badge-success transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
            data-testid="cron-run-status-approve"
          >
            <Check className="h-3 w-3" />
            {copy.approve}
          </button>
          <button /* ds-allow:button: 状态行内超小拒绝按钮，同上 */
            type="button"
            onClick={() => { void handleApproval('deny'); }}
            disabled={approvalBusy}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border-muted px-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            data-testid="cron-run-status-reject"
          >
            <X className="h-3 w-3" />
            {copy.reject}
          </button>
        </span>
      </div>
    );
  }

  if (status?.kind === 'running') {
    return (
      <div
        className="flex items-center gap-2 py-1 text-[13px] text-badge-warning"
        role="status"
        data-testid="cron-run-status"
        data-state="running"
      >
        <span className="cron-run-pulse-dot inline-block h-2 w-2 shrink-0 rounded-full bg-mark-warning" aria-hidden="true" />
        <span data-testid="cron-run-status-text">
          {copy.running.replace('{elapsed}', composeElapsed(splitElapsedParts(now - status.startedAt), {
            hm: copy.elapsedHm,
            ms: copy.elapsedMs,
            s: copy.elapsedS,
          }))}
        </span>
      </div>
    );
  }

  if (
    status?.kind === 'interrupted'
    || status?.kind === 'failed-denied'
    || status?.kind === 'failed-generic'
    || status?.kind === 'cancelled'
  ) {
    const label = status.kind === 'failed-denied'
      ? copy.failedDenied
      : status.kind === 'failed-generic'
        ? copy.failedGeneric
        : status.kind === 'cancelled'
          ? copy.cancelled
          : copy.interrupted;
    return (
      <div
        className="flex flex-wrap items-center gap-2 py-1 text-[13px] text-zinc-400"
        role="status"
        data-testid="cron-run-status"
        data-state={status.kind}
      >
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-mark-neutral" aria-hidden="true" />
        <span data-testid="cron-run-status-text">{label}</span>
        <button /* ds-allow:button: 状态行内超小次级按钮（h-6 px-2 text-xs） */
          type="button"
          onClick={() => { void handleRerun(); }}
          disabled={isRerunning}
          className="inline-flex h-6 items-center rounded-md border border-border-muted px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
          data-testid="cron-run-status-rerun"
        >
          {copy.rerun}
        </button>
      </div>
    );
  }

  if (status?.kind === 'finished') {
    return (
      <div
        className="flex items-center gap-2 py-1 text-[13px] text-zinc-400"
        role="status"
        data-testid="cron-run-status"
        data-state="finished"
      >
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-mark-success" aria-hidden="true" />
        <span data-testid="cron-run-status-text">
          {copy.finished.replace('{duration}', composeElapsed(splitElapsedParts(status.durationMs), {
            hm: copy.elapsedHm,
            ms: copy.elapsedMs,
            s: copy.elapsedS,
          }))}
        </span>
      </div>
    );
  }

  return null;
};
