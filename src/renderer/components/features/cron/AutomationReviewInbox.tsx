// ============================================================================
// AutomationReviewInbox —— 自动化面板顶部的「待过目」收件箱（三件套 A4）。
// 数据源 = sessionAutomation 记录（status=pending_review 或 config.pendingReview），
// 查看结果跳结果会话，已过目清标记。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { SessionAutomationRecord } from '@shared/contract';
import { Check, Inbox, MessageSquareText } from 'lucide-react';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';

function reviewResultSessionId(record: SessionAutomationRecord): string | undefined {
  return record.config?.pendingReview?.resultSessionId ?? record.resultSessionId;
}

export const AutomationReviewInbox: React.FC = () => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const switchSession = useSessionStore((state) => state.switchSession);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const [items, setItems] = useState<SessionAutomationRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    sessionAutomationClient.listPendingReview()
      .then((records) => setItems(records ?? []))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  if (items.length === 0) return null;

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/5 px-5 py-3" data-testid="automation-review-inbox">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-300">
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
            <button /* ds-allow:button: 同上，收件箱行内超小文本按钮 */
              onClick={() => handleMarkReviewed(record)}
              disabled={busyId === record.id}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
              data-testid="automation-review-done"
            >
              <Check className="h-3.5 w-3.5" />
              {cc.inboxMarkDone}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
