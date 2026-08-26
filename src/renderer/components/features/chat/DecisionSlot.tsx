// ============================================================================
// DecisionSlot - 输入框正上方的固定权限决策槽位
// ============================================================================
// 一次只展示一张当前会话可裁决的权限卡；危险与不可撤回写回优先，同级保持
// 现有 pending → 当前会话队列 → global 队列的先来顺序。排序只决定展示对象，
// PermissionCard 仍按请求 id 裁决并由 appStore 从原队列中移除。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { Message, PermissionRequest, StreamRecoverySnapshot } from '@shared/contract';
import { isEditableTool } from '@shared/contract';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildStreamRecoveryMessage } from '../../../utils/streamRecoveryMessage';
import { humanizeInterruptedToolAction } from '../../../utils/streamInterruptionPresentation';
import { Button } from '../../primitives';
import { isEditableTarget } from '../../DecisionCard';
import { PermissionCard } from '../../PermissionDialog/PermissionCard';
import { DecisionCollapsedBar } from '../../DecisionCard';
import { isDangerousCommand } from '../../PermissionDialog/utils';

const GLOBAL_PERMISSION_SESSION_ID = 'global';

interface DecisionSlotCandidate {
  request: PermissionRequest;
  sessionId: string | null;
  order: number;
}

interface StreamInterruptionDecision {
  snapshot: StreamRecoverySnapshot;
  retryMessage: Message;
  onContinue: (message: Message) => Promise<boolean>;
}

const INTERRUPT_DECISION_STORAGE_PREFIX = 'neo:interrupt:resolved:';

function interruptionDecisionKey(sessionId: string | null, turnId: string): string {
  return `${INTERRUPT_DECISION_STORAGE_PREFIX}${sessionId ?? 'unknown'}:${turnId}`;
}

function readInterruptionDecision(sessionId: string | null, turnId: string): boolean {
  try {
    return window.localStorage.getItem(interruptionDecisionKey(sessionId, turnId)) !== null;
  } catch {
    return false;
  }
}

function writeInterruptionDecision(sessionId: string | null, turnId: string, decision: 'continued' | 'abandoned'): void {
  try {
    window.localStorage.setItem(interruptionDecisionKey(sessionId, turnId), decision);
  } catch {
    // 本地水位只负责避免已裁决槽位在重挂载后复现；写失败不阻塞继续/放弃。
  }
}

function interruptionSummary(snapshot: StreamRecoverySnapshot, t: ReturnType<typeof useI18n>['t']): string {
  const firstToolCall = buildStreamRecoveryMessage(snapshot).toolCalls?.[0];
  if (!firstToolCall) return t.chat.streamInterruptedDecisionText;
  const action = humanizeInterruptedToolAction(firstToolCall, t);
  return t.chat.streamInterruptedDecision
    .replace('{action}', action)
    .replace('{extra}', snapshot.toolCalls.length > 1
      ? t.chat.streamInterruptedDecisionExtra.replace('{count}', String(snapshot.toolCalls.length - 1))
      : '');
}

const StreamInterruptionDecisionRow: React.FC<{
  decision: StreamInterruptionDecision;
  sessionId: string | null;
  onResolved: (turnId: string) => void;
}> = ({ decision, sessionId, onResolved }) => {
  const { t } = useI18n();
  const [isContinuing, setIsContinuing] = useState(false);
  const summary = interruptionSummary(decision.snapshot, t);
  const resolve = useCallback((result: 'continued' | 'abandoned') => {
    writeInterruptionDecision(sessionId, decision.snapshot.turnId, result);
    onResolved(decision.snapshot.turnId);
  }, [decision.snapshot.turnId, onResolved, sessionId]);
  const handleContinue = useCallback(async () => {
    if (isContinuing) return;
    setIsContinuing(true);
    try {
      const sent = await decision.onContinue(decision.retryMessage);
      if (sent) resolve('continued');
    } finally {
      setIsContinuing(false);
    }
  }, [decision, isContinuing, resolve]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || isEditableTarget(event.target) || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      void handleContinue();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleContinue]);

  return (
    <div
      className="mx-auto flex h-10 w-full max-w-3xl items-center gap-2 rounded-lg border-2 border-badge-warning/60 bg-surface-primary px-3 text-xs shadow-2xl"
      data-testid="stream-interruption-decision"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-badge-warning" />
      <span className="min-w-0 flex-1 truncate text-zinc-200">{summary}</span>
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="h-7 shrink-0 rounded-md py-1"
        loading={isContinuing}
        onClick={() => void handleContinue()}
      >
        <span className="inline-flex items-center gap-1.5">
          {t.chat.continueInterrupted}
          <kbd className="rounded bg-white/15 px-1 py-px font-mono text-[9px]">Enter</kbd>
        </span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 rounded-md py-1"
        disabled={isContinuing}
        onClick={() => resolve('abandoned')}
      >
        {t.chat.abandonInterrupted}
      </Button>
    </div>
  );
};

function priorityOf(request: PermissionRequest): number {
  const editableWriteback = isEditableTool(request.tool);
  const dangerous = !editableWriteback && (
    request.dangerLevel === 'danger'
    || request.type === 'dangerous_command'
    || (request.type === 'command' && isDangerousCommand(request.details.command))
  );
  if (dangerous) return 0;
  if (editableWriteback) return 1;
  return 2;
}

function visibleCandidates(
  pendingPermissionRequest: PermissionRequest | null,
  pendingPermissionSessionId: string | null,
  queuedPermissionRequests: Record<string, PermissionRequest[]>,
  currentSessionId: string | null,
): DecisionSlotCandidate[] {
  const candidates: DecisionSlotCandidate[] = [];
  const seen = new Set<string>();
  let order = 0;

  const add = (request: PermissionRequest, sessionId: string | null) => {
    if (seen.has(request.id)) return;
    seen.add(request.id);
    candidates.push({ request, sessionId, order });
    order += 1;
  };

  const pendingIsVisible = pendingPermissionRequest && (
    !pendingPermissionSessionId
    || !currentSessionId
    || pendingPermissionSessionId === currentSessionId
  );
  if (pendingPermissionRequest && pendingIsVisible) {
    add(pendingPermissionRequest, pendingPermissionSessionId);
  }

  if (currentSessionId && currentSessionId !== GLOBAL_PERMISSION_SESSION_ID) {
    for (const request of queuedPermissionRequests[currentSessionId] ?? []) {
      add(request, currentSessionId);
    }
  }
  for (const request of queuedPermissionRequests[GLOBAL_PERMISSION_SESSION_ID] ?? []) {
    add(request, null);
  }

  return candidates.sort((left, right) => (
    priorityOf(left.request) - priorityOf(right.request)
    || left.order - right.order
  ));
}

export function DecisionSlot({ streamInterruption }: { streamInterruption?: StreamInterruptionDecision | null }) {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [resolvedTurnId, setResolvedTurnId] = useState<string | null>(null);
  const {
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests = {},
  } = useAppStore();
  const candidates = visibleCandidates(
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests,
    currentSessionId,
  );
  const current = candidates[0];
  const [collapsed, setCollapsed] = useState(false);
  const requestSignature = candidates.map((candidate) => candidate.request.id).join('|');
  const expand = useCallback(() => setCollapsed(false), []);

  // 任何新请求进入可见队列都自动展开，包括当前卡未换但队尾新增的情况。
  useEffect(() => {
    if (requestSignature) setCollapsed(false);
  }, [requestSignature]);

  const interruptionVisible = streamInterruption
    && resolvedTurnId !== streamInterruption.snapshot.turnId
    && !readInterruptionDecision(currentSessionId, streamInterruption.snapshot.turnId);

  if (!current && !interruptionVisible) return null;

  return (
    <section
      aria-label={t.decisionCard.pendingLabel}
      className="w-full shrink-0 chat-col-pad pb-2"
      data-testid="decision-slot"
    >
      {current && collapsed ? (
        <div className="mx-auto flex max-w-3xl justify-end">
          <DecisionCollapsedBar
            label={t.decisionCard.pendingLabel}
            expandLabel={t.decisionCard.expand}
            count={candidates.length}
            onExpand={expand}
            className="w-auto"
            testId="decision-slot-collapsed"
          />
        </div>
      ) : current ? (
        <PermissionCard
          requestOverride={current.request}
          sessionIdOverride={current.sessionId}
          remainingCount={candidates.length - 1}
          onCollapse={() => setCollapsed(true)}
        />
      ) : streamInterruption ? (
        <StreamInterruptionDecisionRow
          decision={streamInterruption}
          sessionId={currentSessionId}
          onResolved={setResolvedTurnId}
        />
      ) : null}
    </section>
  );
}
