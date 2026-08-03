// ============================================================================
// AutomationReviewInbox —— 自动化页首的「待过目」收件箱（三件套 A4，独立卡片区）。
// 数据源 = sessionAutomation 记录（status=pending_review 或 config.pendingReview）
// + 停车审批（parked approvals）；查看结果跳结果会话，已过目清标记。
// 呈现：有内容时是琥珀描边卡片（与侧栏待过目角标同一视觉语言），「已过目」为
// 品牌色主操作；无内容时渲染安静空态「都过目完了 ✓」（不再整块隐藏）。
// onPendingCountChange 把待过目条数回传给页首状态条（语义同服务侧 countPendingReview，
// 只数待过目、不数停车审批）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { PermissionResponse, SessionAutomationRecord } from '@shared/contract';
import type { ParkedApprovalInboxItem } from '@shared/contract/pendingApproval';
import { Check, CircleCheck, Inbox, MessageSquareText, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import ipcService from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Button } from '../../primitives/Button';

function reviewResultSessionId(record: SessionAutomationRecord): string | undefined {
  return record.config?.pendingReview?.resultSessionId ?? record.resultSessionId;
}

function formatWaiting(requestedAt: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - requestedAt) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
}

interface AutomationReviewInboxProps {
  /** 待过目条数变化时回传（加载/刷新后都会调一次），供页首状态条显示 */
  onPendingCountChange?: (count: number) => void;
}

export const AutomationReviewInbox: React.FC<AutomationReviewInboxProps> = ({ onPendingCountChange }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const switchSession = useSessionStore((state) => state.switchSession);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const [items, setItems] = useState<SessionAutomationRecord[]>([]);
  const [parked, setParked] = useState<ParkedApprovalInboxItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    sessionAutomationClient.listPendingReview()
      .then((records) => {
        const list = records ?? [];
        setItems(list);
        onPendingCountChange?.(list.length);
      })
      .catch(() => {
        setItems([]);
        onPendingCountChange?.(0);
      });
    sessionAutomationClient.listParkedApprovals()
      .then((rows) => setParked(rows ?? []))
      .catch(() => setParked([]));
  }, [onPendingCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  const handleResolveParked = async (item: ParkedApprovalInboxItem, response: PermissionResponse) => {
    if (item.status !== 'pending') return; // orphaned 不可操作
    setBusyId(item.id);
    try {
      // 复用会话审批 IPC：同一 requestId 命中内存 pending，走 first-responder-wins 裁决口。
      // 宿主已死（进程重启）时 host 会把行标 orphaned 并回报 outcome——必须告知用户，
      // 不能让点击看起来「没反应」（2026-07-26 真机 D0）。
      const result = (await ipcService.invoke(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, item.id, response, item.sessionId ?? undefined,
      )) as { outcome?: string; orphaned?: boolean } | undefined;
      if (result && (result.orphaned === true || (result.outcome && result.outcome !== 'delivered'))) {
        toast.info(cc.parkedResolveStale);
      }
    } catch {
      toast.error(cc.parkedResolveFailed);
    } finally {
      setBusyId(null);
      load(); // 无论成败都刷新：orphaned 转灰态 / 失败恢复可点
    }
  };

  const handleOpenResult = async (record: SessionAutomationRecord) => {
    const sessionId = reviewResultSessionId(record);
    setBusyId(record.id);
    try {
      await sessionAutomationClient.markReviewed(record.id);
      if (sessionId) {
        await switchSession(sessionId);
        setShowCronCenter(false);
      }
      load();
    } finally {
      setBusyId(null);
    }
  };

  const handleMarkReviewed = async (record: SessionAutomationRecord) => {
    setBusyId(record.id);
    try {
      await sessionAutomationClient.markReviewed(record.id);
      load();
    } finally {
      setBusyId(null);
    }
  };

  const hasContent = items.length > 0 || parked.length > 0;

  return (
    <div className="shrink-0 px-5 pt-4" data-testid="automation-review-inbox">
      {!hasContent ? (
        <div
          className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-2.5 text-xs text-zinc-500"
          data-testid="automation-review-all-clear"
        >
          <CircleCheck className="h-3.5 w-3.5 text-badge-success" />
          {cc.inboxAllClear}
        </div>
      ) : (
        <div className="max-h-[32vh] overflow-y-auto rounded-xl border border-badge-warning/25 bg-amber-500/5 px-4 py-3">
          {parked.length > 0 && (
            <div className="mb-3" data-testid="parked-approval-group">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-badge-warning">
                <ShieldAlert className="h-3.5 w-3.5" />
                {cc.parkedTitle.replace('{count}', String(parked.length))}
              </div>
              <div className="space-y-1.5">
                {parked.map((item) => {
                  const isOrphaned = item.status === 'orphaned';
                  const isExternal = item.riskClass === 'external';
                  // A4 作用域提示：external 动作离开本机（暖色边框强调）；有 target 时点名去向。
                  // 非 external 审批卡不变（不加 scopeNote、不换边框）。
                  const scopeNote = isExternal
                    ? cc.parkedScopeExternal.replace('{target}', item.standingGrantTarget ?? (item.displayTool ?? item.tool))
                    : null;
                  // B4 铸权入口：仅 external + 能确定性提取 target 时出现（模型侧无入口）。
                  const canMintStanding = isExternal && !!item.standingGrantTarget;
                  return (
                    <div
                      key={item.id}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border ${isExternal ? 'border-badge-warning/40 bg-orange-500/[0.03]' : 'border-zinc-800 bg-zinc-950/50'} px-3 py-2 ${isOrphaned ? 'opacity-50' : ''}`}
                      data-testid="parked-approval-item"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 truncate text-sm text-zinc-200">
                          {item.displayTool ?? item.tool}
                          {isExternal && (
                            <span className="shrink-0 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-badge-warning">
                              {cc.parkedExternalBadge}
                            </span>
                          )}
                        </div>
                        {scopeNote && (
                          <div className="truncate text-[11px] text-badge-warning/80" data-testid="parked-scope-note">
                            {scopeNote}
                          </div>
                        )}
                        <div className="text-[11px] text-zinc-500">
                          {isOrphaned ? cc.parkedOrphaned : cc.parkedWaiting.replace('{duration}', formatWaiting(item.requestedAt))}
                        </div>
                      </div>
                      {!isOrphaned && (
                        <>
                          <button /* ds-allow:button: 收件箱行内超小文本按钮（py-1 text-xs） */
                            onClick={() => handleResolveParked(item, 'allow')}
                            disabled={busyId === item.id}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-badge-success transition-colors hover:bg-emerald-500/10 hover:text-badge-success disabled:opacity-50"
                            data-testid="parked-approve"
                          >
                            <Check className="h-3.5 w-3.5" />
                            {cc.parkedApprove}
                          </button>
                          {canMintStanding && (
                            <button /* ds-allow:button: 同上，收件箱行内超小文本按钮 */
                              onClick={() => handleResolveParked(item, 'allow_standing')}
                              disabled={busyId === item.id}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-badge-warning transition-colors hover:bg-amber-500/10 hover:text-badge-warning disabled:opacity-50"
                              data-testid="parked-always-allow"
                              title={cc.parkedAlwaysAllow.replace('{target}', item.standingGrantTarget ?? '')}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              {cc.parkedAlwaysAllow.replace('{target}', item.standingGrantTarget ?? '')}
                            </button>
                          )}
                          <button /* ds-allow:button: 同上，收件箱行内超小文本按钮 */
                            onClick={() => handleResolveParked(item, 'deny')}
                            disabled={busyId === item.id}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                            data-testid="parked-reject"
                          >
                            <X className="h-3.5 w-3.5" />
                            {cc.parkedReject}
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {items.length > 0 && (
            <>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-badge-warning">
                <Inbox className="h-3.5 w-3.5" />
                {cc.inboxTitle.replace('{count}', String(items.length))}
              </div>
              <div className="space-y-1.5">
                {items.map((record) => (
                  <div
                    key={record.id}
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
                    data-testid="automation-review-item"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-zinc-200">{record.title}</div>
                      {record.config?.pendingReview?.at != null && (
                        <div className="text-[11px] text-zinc-500">
                          {new Date(record.config.pendingReview.at).toLocaleString()}
                        </div>
                      )}
                    </div>
                    {reviewResultSessionId(record) && (
                      <button /* ds-allow:button: 收件箱行内超小文本按钮（py-1 text-xs），primitive 最小 sm 仍更大 */
                        onClick={() => handleOpenResult(record)}
                        disabled={busyId === record.id}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-blue-400 transition-colors hover:bg-blue-500/10 hover:text-blue-300 disabled:opacity-50"
                      >
                        <MessageSquareText className="h-3.5 w-3.5" />
                        {cc.inboxOpenResult}
                      </button>
                    )}
                    {/* 「已过目」是收件箱的主操作（每条都要点的闭环动作），用品牌色主按钮；
                        「查看结果」是跳走的次操作，保持行内文本按钮。 */}
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => handleMarkReviewed(record)}
                      disabled={busyId === record.id}
                      leftIcon={<Check className="h-3.5 w-3.5" />}
                      data-testid="automation-review-done"
                    >
                      {cc.inboxMarkDone}
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
