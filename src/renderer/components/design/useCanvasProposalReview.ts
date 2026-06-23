// ADR-026 D2-A：订阅 agent 画布提议（CANVAS_PROPOSAL_ASK）→ 持待审批态 → Apply/Reject 落地。
import { useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CanvasOpProposal } from '@shared/contract';
import ipcService from '../../services/ipcService';
import { useCanvasProposalStore } from './canvasProposalStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';
import { applyProposal, rejectProposal, type ProposalControllerDeps } from './canvasProposalController';
import type { ProposalApplyResult } from './applyCanvasProposal';

function makeGenId(): (kind: string, index: number) => string {
  // index 入 id 防同批/同毫秒碰撞（crypto 不可用的兜底路径也唯一）。
  return (kind, index) =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? `${kind}-${index}-${crypto.randomUUID()}`
      : `${kind}-${Date.now()}-${index}`;
}

function controllerDeps(): ProposalControllerDeps {
  return {
    applyBatch: (ops, opts) => useDesignCanvasStore.getState().applyProposalBatch(ops, opts),
    save: async () => {
      const { runDir, toDoc } = useDesignCanvasStore.getState();
      if (runDir) await saveCanvasDoc(runDir, toDoc());
    },
    respond: (decision) => ipcService.invoke(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE, decision),
    genId: makeGenId(),
    now: () => Date.now(),
  };
}

export interface CanvasProposalReview {
  pending: CanvasOpProposal | null;
  apply: () => Promise<ProposalApplyResult | void>;
  reject: (feedback?: string) => Promise<void>;
}

export function useCanvasProposalReview(): CanvasProposalReview {
  const pending = useCanvasProposalStore((s) => s.pending);
  const setPending = useCanvasProposalStore((s) => s.setPending);
  const clear = useCanvasProposalStore((s) => s.clear);

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.CANVAS_PROPOSAL_ASK, (request: CanvasOpProposal) => {
      setPending(request);
    });
    return () => unsubscribe?.();
  }, [setPending]);

  const apply = useCallback(async () => {
    if (!pending) return;
    try {
      return await applyProposal(pending, controllerDeps());
    } finally {
      // 用户已决策：即使回 agent 的 IPC 失败也清掉审批条，不把 UI 卡住（本地变更已落）。
      clear();
    }
  }, [pending, clear]);

  const reject = useCallback(async (feedback?: string) => {
    if (!pending) return;
    try {
      await rejectProposal(pending, { respond: controllerDeps().respond }, feedback);
    } finally {
      clear();
    }
  }, [pending, clear]);

  return { pending, apply, reject };
}
