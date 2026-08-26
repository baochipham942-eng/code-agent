// ============================================================================
// DecisionSlot - 输入框正上方的固定权限决策槽位
// ============================================================================
// 一次只展示一张当前会话可裁决的权限卡；危险与不可撤回写回优先，同级保持
// 现有 pending → 当前会话队列 → global 队列的先来顺序。排序只决定展示对象，
// PermissionCard 仍按请求 id 裁决并由 appStore 从原队列中移除。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { PermissionRequest } from '@shared/contract';
import { isEditableTool } from '@shared/contract';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { PermissionCard } from '../../PermissionDialog/PermissionCard';
import { DecisionCollapsedBar } from '../../DecisionCard';
import { isDangerousCommand } from '../../PermissionDialog/utils';

const GLOBAL_PERMISSION_SESSION_ID = 'global';

interface DecisionSlotCandidate {
  request: PermissionRequest;
  sessionId: string | null;
  order: number;
}

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

export function DecisionSlot() {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
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

  if (!current) return null;

  return (
    <section
      aria-label={t.decisionCard.pendingLabel}
      className="w-full shrink-0 chat-col-pad pb-2"
      data-testid="decision-slot"
    >
      {collapsed ? (
        <DecisionCollapsedBar
          label={t.decisionCard.pendingLabel}
          expandLabel={t.decisionCard.expand}
          count={candidates.length}
          onExpand={expand}
          testId="decision-slot-collapsed"
        />
      ) : (
        <PermissionCard
          requestOverride={current.request}
          sessionIdOverride={current.sessionId}
          remainingCount={candidates.length - 1}
          onCollapse={() => setCollapsed(true)}
        />
      )}
    </section>
  );
}
