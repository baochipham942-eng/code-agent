// ============================================================================
// AutomationReviewInbox —— 自动化页首的「待过目」收件箱（三件套 A4，独立卡片区）。
// 数据源 = sessionAutomation 记录（status=pending_review 或 config.pendingReview）
// + 停车审批（parked approvals）；查看结果跳结果会话，已过目清标记。
// 待过目按紧急档位三档分组（N-CRON-INBOX-URGENCY-TIER）：must_today 置顶带角标，
// 空档不渲染；档位来自结果头部行（shared/cronUrgency），老记录归 fyi。
// 呈现：有内容时是琥珀描边卡片（与侧栏待过目角标同一视觉语言），「已过目」为
// 品牌色主操作；无内容时渲染安静空态「都过目完了 ✓」（不再整块隐藏）。
// onPendingCountChange 通知页首「列表变了，重取 countPendingReview」。回传值是记录数，
// 只作刷新信号；标题与 tile 都读服务侧按任务折算的 countPendingReview。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { CronUrgency, PermissionResponse, SessionAutomationRecord } from '@shared/contract';
import type { ParkedApprovalInboxItem } from '@shared/contract/pendingApproval';
import { isCronUrgency } from '@shared/cronUrgency';
import { isCronPermissionDeniedMarker } from '@shared/cronPermissionDenied';
import { Check, CircleCheck, Cloud, ExternalLink, Inbox, MessageSquareText, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import ipcService from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { CRON_REVIEW_INBOX_TIMEOUTS } from '@shared/constants';
import { createLogger } from '../../../utils/logger';
import { localizeParkedApprovalClosureText } from '../../../utils/toolExecutionPresentation';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Button } from '../../primitives/Button';
import { SensitiveStepParkedRow } from '../../PermissionDialog/SensitiveStepHandbackCard';
import { openCronLoginWallSite } from './cronLoginWallNotice';
import { CronReviewDigest } from './CronReviewDigest';

const logger = createLogger('AutomationReviewInbox');

function reviewResultSessionId(record: SessionAutomationRecord): string | undefined {
  return record.config?.pendingReview?.resultSessionId ?? record.resultSessionId;
}

/** 三档分组（N-CRON-INBOX-URGENCY-TIER）：must_today 置顶带角标，空档不渲染；无档位/坏值一律归 fyi。 */
const URGENCY_SECTION_ORDER: readonly CronUrgency[] = ['must_today', 'can_wait', 'fyi'];

function recordUrgency(record: SessionAutomationRecord): CronUrgency {
  const urgency = record.config?.pendingReview?.urgency;
  return isCronUrgency(urgency) ? urgency : 'fyi';
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
  /**
   * 外部新鲜度信号（Rework r1）：收件箱常驻挂载、只在 mount 时拉一次，停车审批
   * 发生在面板开着时不会自动出现。父级在等批准集合变化（出现/消失）时变更本值，
   * 收件箱随之重拉 listParkedApprovals——「去处理」才不会落到不含该审批的旧快照。
   */
  refreshSignal?: string | number;
}

export const AutomationReviewInbox: React.FC<AutomationReviewInboxProps> = ({ onPendingCountChange, refreshSignal }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const switchSession = useSessionStore((state) => state.switchSession);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const [items, setItems] = useState<SessionAutomationRecord[]>([]);
  const [parked, setParked] = useState<ParkedApprovalInboxItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 标题与页首 tile 同一口径：服务侧 countPendingReview（按任务折算）。失败时保留上次值（从未成功过则标题回落到记录数）。
  const [reviewCount, setReviewCount] = useState<number | null>(null);

  const handleRerunLoginWall = async (record: SessionAutomationRecord) => {
    const jobId = record.sourceRefId;
    if (!jobId || busyId === record.id) return;
    setBusyId(record.id);
    try {
      await useCronStore.getState().triggerJob(jobId);
    } catch {
      // A failed manual retry must be visible; otherwise the finally refresh
      // makes the click look like it succeeded while the job remains parked.
      toast.error(cc.failureOther);
    } finally {
      setBusyId(null);
      load();
    }
  };

  const load = useCallback(() => {
    // 失败一律保留上一次的值（不清空、不回报 0），并 warn 留痕：服务掉线时「0」是假数。
    const warnFailed = (what: string) => (error: unknown) => {
      logger.warn(`Failed to load ${what}, keeping last known value`, {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    };
    sessionAutomationClient.listPendingReview()
      .then((records) => {
        const list = records ?? [];
        setItems(list);
        onPendingCountChange?.(list.length);
      })
      .catch(warnFailed('pending review list'));
    sessionAutomationClient.countPendingReview()
      .then((count) => {
        if (typeof count === 'number') setReviewCount(count);
      })
      .catch(warnFailed('pending review count'));
    sessionAutomationClient.listParkedApprovals()
      .then((rows) => setParked(rows ?? []))
      .catch(warnFailed('parked approvals'));
  }, [onPendingCountChange]);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  // 页面停着时定时任务跑完也要自动刷新：可见时低频轮询，切回前台/窗口聚焦立即重拉。
  useEffect(() => {
    const isVisible = () => document.visibilityState === 'visible';
    const timer = setInterval(() => {
      if (isVisible()) load();
    }, CRON_REVIEW_INBOX_TIMEOUTS.POLL_INTERVAL);
    const onWake = () => {
      if (isVisible()) load();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
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

  const handleOpenLoginWallSite = (record: SessionAutomationRecord) => {
    const siteOrigin = record.config?.loginWall?.siteOrigin;
    if (siteOrigin) openCronLoginWallSite(siteOrigin, record.sourceRefId);
  };

  const hasContent = items.length > 0 || parked.length > 0;
  const urgencyGroups: Record<CronUrgency, SessionAutomationRecord[]> = {
    must_today: [],
    can_wait: [],
    fyi: [],
  };
  for (const record of items) urgencyGroups[recordUrgency(record)].push(record);

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
              {parked.some((item) => item.status !== 'voided') && (
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-badge-warning">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {cc.parkedTitle.replace('{count}', String(parked.filter((item) => item.status === 'pending').length))}
                </div>
              )}
              <div className="space-y-1.5">
                {parked.map((item) => {
                  if (item.status === 'voided') {
                    return (
                      <div
                        key={item.id}
                        className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 opacity-50"
                        data-testid="parked-approval-voided"
                      >
                        <div className="truncate text-sm text-zinc-200">{item.displayTool ?? item.tool}</div>
                        <div className="text-[11px] text-zinc-500">
                          {/* 收口句按当前语言展示（老行持久化的是中文原句）；非收口文本原样保留 */}
                          {cc.parkedVoidedLabel}：{localizeParkedApprovalClosureText(item.voidReason, t) ?? item.voidReason}
                        </div>
                      </div>
                    );
                  }
                  const isOrphaned = item.status === 'orphaned';
                  const isPairing = item.kind === 'channel_pairing';
                  const isExternal = item.riskClass === 'external';
                  // ADR-088 敏感步骤交回：单状态交回卡（[完成后继续]/[这步不做了]），
                  // 不出「每次都允许」铸权入口——host 侧对交回应答永不铸造授权。
                  if (item.sensitiveStep) {
                    return (
                      <div
                        key={item.id}
                        className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 ${isOrphaned ? 'opacity-50' : ''}`}
                        data-testid="parked-approval-item"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-zinc-200">{item.displayTool ?? item.tool}</div>
                          <SensitiveStepParkedRow
                            step={item.sensitiveStep}
                            onRespond={(response) => { void handleResolveParked(item, response); }}
                            disabled={busyId === item.id || isOrphaned}
                          />
                        </div>
                      </div>
                    );
                  }
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
                          {isPairing
                            ? cc.pairingTitle.replace('{channel}', item.pairingChannel === 'lark' ? 'Lark' : 'Feishu')
                            : (item.displayTool ?? item.tool)}
                          {isExternal && (
                            <span className="shrink-0 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-badge-warning">
                              {cc.parkedExternalBadge}
                            </span>
                          )}
                        </div>
                        {isPairing && item.pairingCode && (
                          <div className="text-xs font-medium text-badge-warning" data-testid="pairing-code">
                            {cc.pairingCode.replace('{code}', item.pairingCode)}
                          </div>
                        )}
                        {isPairing && item.pairingSender && (
                          <div className="truncate text-[11px] text-zinc-400">
                            {cc.pairingSender.replace('{sender}', item.pairingSender)}
                          </div>
                        )}
                        {scopeNote && (
                          <div className="truncate text-[11px] text-badge-warning/80" data-testid="parked-scope-note">
                            {scopeNote}
                          </div>
                        )}
                        {/* 参数预览（host 已脱敏 + 截断）：一眼看清这步要干什么；老行没有该字段不渲染 */}
                        {!isPairing && item.argsPreview && (
                          <div
                            className="truncate text-[11px] text-zinc-400"
                            data-testid="parked-args-preview"
                            title={item.argsPreview}
                          >
                            {cc.parkedArgsPreviewLabel}{item.argsPreview}
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
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-badge-warning" data-testid="automation-review-inbox-title">
                <Inbox className="h-3.5 w-3.5" />
                {cc.inboxTitle.replace('{count}', String(reviewCount ?? items.length))}
              </div>
              <div className="space-y-2.5">
                {URGENCY_SECTION_ORDER.map((tier) => {
                  const tierItems = urgencyGroups[tier];
                  if (tierItems.length === 0) return null;
                  const isMustToday = tier === 'must_today';
                  const sectionTitle = tier === 'must_today'
                    ? cc.inboxUrgencySectionMustToday
                    : tier === 'can_wait'
                      ? cc.inboxUrgencySectionCanWait
                      : cc.inboxUrgencySectionFyi;
                  return (
                    <div key={tier} data-testid={`automation-urgency-section-${tier}`}>
                      <div className={`mb-1.5 text-[11px] font-medium ${isMustToday ? 'text-badge-warning' : 'text-zinc-500'}`}>
                        {sectionTitle}
                      </div>
                      <div className="space-y-1.5">
                        {tierItems.map((record) => {
                        const isCloud = record.config?.runsOn === 'cloud';
                        const urgencyRaw = record.config?.pendingReview?.urgencyRaw;
                        const digest = record.config?.pendingReview?.digest;
                        const maxRunsReached = record.config?.pendingReview?.maxRunsReached;
                        // 需处理（N-CRON-RUN-COMPLETED-BUT-DENIED）：被拒且无产出的运行带琥珀徽章。
                        const permissionDenied = isCronPermissionDeniedMarker(record.config?.pendingReview?.permissionDenied);
                        const resultSessionId = reviewResultSessionId(record);
                        const hasPendingApproval = Boolean(
                          resultSessionId
                          && parked.some((item) => item.status === 'pending' && item.sessionId === resultSessionId),
                        );
                        return (
                        <div
                          key={record.id}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${isMustToday ? 'border-badge-warning/30 bg-amber-500/[0.04]' : 'border-zinc-800 bg-zinc-950/50'}`}
                          data-testid="automation-review-item"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="truncate text-sm text-zinc-200">{record.title}</div>
                              {isMustToday && (
                                <span
                                  className="inline-flex shrink-0 items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-badge-warning"
                                  data-testid="automation-urgency-badge"
                                >
                                  {cc.inboxUrgencyBadge}
                                </span>
                              )}
                              {permissionDenied && (
                                <span
                                  className="inline-flex shrink-0 items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-badge-warning"
                                  data-testid="automation-review-permission-denied"
                                >
                                  {cc.permissionDeniedBadge}
                                </span>
                              )}
                              {isCloud && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-badge-info/30 bg-blue-500/10 px-2 py-0.5 text-[10px] text-badge-info">
                                  <Cloud className="h-3 w-3" />
                                  {cc.locationCloud}
                                </span>
                              )}
                            </div>
                            {digest && (
                              <CronReviewDigest
                                digest={digest}
                                trailing={hasPendingApproval ? (
                                  <span
                                    className="inline-flex shrink-0 items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-badge-warning"
                                    data-testid="automation-review-digest-approval"
                                  >
                                    {cc.inboxDigestApprovalBadge}
                                  </span>
                                ) : undefined}
                              />
                            )}
                            {maxRunsReached && (
                              <div className="truncate text-[11px] text-badge-warning" data-testid="automation-review-max-runs">
                                {maxRunsReached.summary ?? cc.inboxMaxRunsReached.replace('{count}', String(maxRunsReached.maxRuns))}
                              </div>
                            )}
                            {urgencyRaw && (
                              <div className="truncate text-[11px] text-zinc-500" data-testid="automation-urgency-raw">
                                {cc.inboxUrgencyRawPrefix}{urgencyRaw}
                              </div>
                            )}
                            {record.config?.missedNotice ? (
                              <div className="text-[11px] text-badge-warning" data-testid="automation-review-missed">
                                {record.config.missedNotice.reason === 'webhook-expired'
                                  ? cc.inboxWebhookExpired.replace(
                                    '{count}',
                                    String(record.config.missedNotice.count ?? 0),
                                  )
                                  : cc.inboxMissedAt.replace(
                                    '{time}',
                                    new Date(record.config.missedNotice.scheduledAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN'),
                                  )}
                              </div>
                            ) : record.config?.loginWall ? (
                              <div className="text-[11px] text-badge-warning" data-testid="automation-review-login-wall">
                                {cc.loginWallError.replace('{site}', record.config.loginWall.siteOrigin)}
                              </div>
                            ) : record.config?.pendingReview?.at != null && (
                              <div className="text-[11px] text-zinc-500">
                                {isCloud
                                  ? cc.inboxCloudCompleted.replace(
                                    '{time}',
                                    new Date(record.config.pendingReview.at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN'),
                                  )
                                  : new Date(record.config.pendingReview.at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
                              </div>
                            )}
                          </div>
                          {resultSessionId && (
                            <button /* ds-allow:button: 收件箱行内超小文本按钮（py-1 text-xs），primitive 最小 sm 仍更大 */
                              onClick={() => handleOpenResult(record)}
                              disabled={busyId === record.id}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-badge-info transition-colors hover:bg-blue-500/10 hover:text-badge-info disabled:opacity-50"
                            >
                              <MessageSquareText className="h-3.5 w-3.5" />
                              {cc.inboxOpenResult}
                            </button>
                          )}
                          {record.config?.loginWall?.siteOrigin && (
                            <>
                              <button /* ds-allow:button: 收件箱行内超小警示色文本按钮（px-2 py-1 text-xs），与同行「查看结果」同款，primitive 最小 sm 仍更大且无警示色 variant */
                                type="button"
                                onClick={() => handleOpenLoginWallSite(record)}
                                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-badge-warning transition-colors hover:bg-amber-500/10"
                                data-testid="automation-review-open-login-site"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                {cc.loginWallOpenSite}
                              </button>
                              {record.sourceRefId && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  loading={busyId === record.id}
                                  onClick={() => { void handleRerunLoginWall(record); }}
                                  data-testid="automation-review-login-wall-rerun"
                                >
                                  {cc.failureActionRunAgain}
                                </Button>
                              )}
                            </>
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
                        );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
