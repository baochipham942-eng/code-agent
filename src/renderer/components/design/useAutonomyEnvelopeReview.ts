// ADR-027 slice5：订阅 agent 信封请求（CANVAS_AUTONOMY_ASK）→ 持待审批态 → Grant/Decline。
// Grant 时在 renderer 建立信封（成本权威所在，红线④）+ 回裁决；之后 proposeCanvasOps 的
// generateImage 提议会在信封内自动放行（见 useCanvasProposalReview）。
import { useEffect, useCallback } from 'react';
import { IPC_CHANNELS, type SessionStatusUpdateEvent } from '@shared/ipc';
import type { AutonomyEnvelopeRequest, AutonomyGrant } from '@shared/contract';
import ipcService from '../../services/ipcService';
import { useDesignAutonomyStore } from './designAutonomyStore';
import { isAutonomyRunTerminal } from './autonomyProposalRouting';

export interface AutonomyEnvelopeReview {
  pendingRequest: AutonomyEnvelopeRequest | null;
  /** 批准信封（granted=人最终确认值）：建立信封 + 回 grant 裁决。 */
  grant: (granted: AutonomyGrant) => Promise<void>;
  /** 不批：回 decline 裁决（可带意见）。 */
  decline: (feedback?: string) => Promise<void>;
}

/** 仅当 store 当前 pendingRequest 仍是该 requestId 才清——防并发请求互相误清。 */
function clearIfStill(requestId: string): void {
  const st = useDesignAutonomyStore.getState();
  if (st.pendingRequest?.requestId === requestId) st.setPendingRequest(null);
}

export function useAutonomyEnvelopeReview(): AutonomyEnvelopeReview {
  const pendingRequest = useDesignAutonomyStore((s) => s.pendingRequest);
  const setPendingRequest = useDesignAutonomyStore((s) => s.setPendingRequest);

  useEffect(() => {
    const unsubAsk = ipcService.on(IPC_CHANNELS.CANVAS_AUTONOMY_ASK, (request: AutonomyEnvelopeRequest) => {
      setPendingRequest(request);
    });
    // abort/超时：撤掉信封审批面板（防孤儿信封被后点 Grant）。仅撤当前这条，不调 respond（agent 已不在监听）。
    const unsubCancel = ipcService.on(IPC_CHANNELS.CANVAS_AUTONOMY_CANCEL, (payload: { requestId: string }) => {
      clearIfStill(payload.requestId);
    });
    // 审计 HIGH-2：信封绑 agent run 生命周期——拥有它的 session 进终态（完成/中断/取消/空闲）即作废信封，
    // 杜绝「run 结束后孤儿信封在下一轮无人复批即自动付费」。绑 sessionId 防误清他 session 的信封。
    const unsubStatus = ipcService.on(IPC_CHANNELS.SESSION_STATUS_UPDATE, (event: SessionStatusUpdateEvent) => {
      const st = useDesignAutonomyStore.getState();
      if (!st.envelope) return;
      if (st.envelopeSessionId && event.sessionId !== st.envelopeSessionId) return; // 非本信封的 session
      if (isAutonomyRunTerminal(event.status)) st.clear();
    });
    return () => {
      unsubAsk?.();
      unsubCancel?.();
      unsubStatus?.();
    };
  }, [setPendingRequest]);

  const grant = useCallback(async (granted: AutonomyGrant) => {
    const req = useDesignAutonomyStore.getState().pendingRequest;
    if (!req) return;
    // 在 renderer 建立信封（夹紧 + 派生默认经 grantEnvelope，与 main 工具同口径）；绑请求的 sessionId（HIGH-2）。
    useDesignAutonomyStore.getState().grantFromApproval(granted, req.sessionId);
    try {
      await ipcService.invoke(IPC_CHANNELS.CANVAS_AUTONOMY_RESPONSE, { requestId: req.requestId, verdict: 'grant', granted });
    } finally {
      clearIfStill(req.requestId);
    }
  }, []);

  const decline = useCallback(async (feedback?: string) => {
    const req = useDesignAutonomyStore.getState().pendingRequest;
    if (!req) return;
    try {
      await ipcService.invoke(IPC_CHANNELS.CANVAS_AUTONOMY_RESPONSE, {
        requestId: req.requestId,
        verdict: 'decline',
        ...(feedback && feedback.trim() ? { feedback: feedback.trim() } : {}),
      });
    } finally {
      clearIfStill(req.requestId);
    }
  }, []);

  return { pendingRequest, grant, decline };
}
