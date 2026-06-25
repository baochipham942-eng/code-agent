// ADR-026 D2-A：订阅 agent 画布提议（CANVAS_PROPOSAL_ASK）→ 持待审批态 → Apply/Reject 落地。
import { useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CanvasOpProposal } from '@shared/contract';
import ipcService from '../../services/ipcService';
import { useCanvasProposalStore } from './canvasProposalStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';
import {
  applyProposal,
  rejectProposal,
  type ProposalControllerDeps,
  type ProposalApplyOutcome,
} from './canvasProposalController';
import type { CanvasProposalOp } from '@shared/contract';
import { planDiscards } from './applyCanvasProposal';
import { generateProposedImage, resolveProposedImageModel } from './designProposedImageGen';
import { decideProposalHandling, autonomousApply, makeGroupedGenerate } from './autonomyProposalRouting';
import { isExhausted } from '@shared/contract/designAutonomy';
import { estimateImageCostCny } from '@shared/media/imageCost';
import { useDesignAutonomyStore } from './designAutonomyStore';
import { useDesignStore } from './designStore';

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
    // 软删：仅淘汰当前存在且未淘汰的节点（stale/重复的跳过，planDiscards 去重），走 store.discardNode（Layer2 可恢复）。
    applyDiscards: (nodeIds) => {
      const st = useDesignCanvasStore.getState();
      const live = new Set(st.nodes.filter((n) => !n.discarded).map((n) => n.id));
      const { toDiscard, applied, skipped } = planDiscards(live, nodeIds);
      for (const id of toDiscard) st.discardNode(id);
      return { applied, skipped };
    },
    save: async () => {
      const { runDir, toDoc } = useDesignCanvasStore.getState();
      if (runDir) await saveCanvasDoc(runDir, toDoc());
    },
    respond: (decision) => ipcService.invoke(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE, decision),
    genId: makeGenId(),
    now: () => Date.now(),
    // 二刀 Layer2：真出图（出图 IPC + addNode，不落盘不清史）；clearHistory 由 controller 在 ≥1 张落地后调。
    generate: (op) => generateProposedImage(op),
    clearHistory: () => useDesignCanvasStore.getState().clearEditHistory(),
    // MED-1：付费生成期间置 generating——既锁住表单出图入口，又驱动画布阻断叠层（DesignCanvas 据此禁手动编辑）。
    setBusy: (busy) => useDesignCanvasStore.getState().setGenerating(busy),
  };
}

export interface CanvasProposalReview {
  pending: CanvasOpProposal | null;
  /** 是否有提议正在落地（含 Phase B 出图）——驱动画布忙态遮罩（R3 MED-1）。 */
  applying: boolean;
  apply: (selectedOps?: CanvasProposalOp[]) => Promise<ProposalApplyOutcome | void>;
  reject: (feedback?: string) => Promise<void>;
}

/** 仅当 store 当前 pending 仍是该 requestId 才清——防并发提议互相误清（R3 MED-2）。 */
function clearIfStill(requestId: string): void {
  const st = useCanvasProposalStore.getState();
  if (st.pending?.requestId === requestId) st.clear();
}

export function useCanvasProposalReview(): CanvasProposalReview {
  const pending = useCanvasProposalStore((s) => s.pending);
  const applyingRequestId = useCanvasProposalStore((s) => s.applyingRequestId);
  const setPending = useCanvasProposalStore((s) => s.setPending);

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.CANVAS_PROPOSAL_ASK, (request: CanvasOpProposal) => {
      // ADR-027：有活跃信封 ∧ 非破坏性 → 自动应用（不弹人闸）；否则走 026 逐步人审批。
      const env = useDesignAutonomyStore.getState().envelope;
      if (decideProposalHandling(request, env) === 'auto') {
        const cs = useCanvasProposalStore.getState();
        // 单飞：已有提议在落地则退回人闸兜底（设 pending），不并发自动应用。
        if (cs.applyingRequestId) { cs.setPending(request); return; }
        cs.setApplying(request.requestId);
        // 出图归入本轮变体组（首张建组，后续同组）——N 张兄弟变体供人挑。
        const groupedGenerate = makeGroupedGenerate({
          getGroupId: () => useDesignAutonomyStore.getState().variantGroupId,
          setGroupId: (id) => useDesignAutonomyStore.getState().setVariantGroupId(id),
          generate: (op, opts) => generateProposedImage(op, opts),
        });
        void (async () => {
          try {
            await autonomousApply(request, {
              baseDeps: { ...controllerDeps(), generate: groupedGenerate },
              // HIGH-1 + R2-MED-1：预算闸单价取「价表估值」与「grant 时快照真实单价」的较大者——
              // fail-closed，自定义模型不被运行时拉取失败拉低到 0.14 绕过 ¥ 闸；不在自主期依赖运行时拉取。
              estimateCost: (op) => {
                const resolved = resolveProposedImageModel(op.model, useDesignStore.getState().imageModel);
                const snapshot = useDesignAutonomyStore.getState().perImageCny ?? 0;
                return Math.max(estimateImageCostCny(resolved), snapshot);
              },
              getEnvelope: () => useDesignAutonomyStore.getState().envelope,
              setEnvelope: (e) => useDesignAutonomyStore.getState().setEnvelope(e),
            });
          } finally {
            useCanvasProposalStore.getState().setApplying(null);
            // MED-1：本轮耗尽即作废信封，免后续免费 op 在「已批准窗口外」继续自动应用。
            const envNow = useDesignAutonomyStore.getState().envelope;
            if (envNow && isExhausted(envNow)) useDesignAutonomyStore.getState().clear();
          }
        })();
        return;
      }
      setPending(request);
    });
    // 审计 MED-3：agent abort/超时后撤掉审批条，避免孤儿提议被后点 Apply 触发付费生成。
    // 仅撤当前这条（requestId 匹配），不调 respond——agent 已不在监听。
    const unsubCancel = ipcService.on(IPC_CHANNELS.CANVAS_PROPOSAL_CANCEL, (payload: { requestId: string }) => {
      // ADR-027 审计 HIGH-2(a)：自主 run 的 proposeCanvasOps abort/超时 → **无条件**作废活跃信封
      // （即便正落地这条；abort 应停止后续付费）。与「忽略 UI 撤条」解耦——付费已 commit 只阻止撤审批条，不阻止信封作废。
      if (useDesignAutonomyStore.getState().envelope) useDesignAutonomyStore.getState().clear();
      // R3 HIGH-1：用 store 级锁（跨重挂存活）而非组件 ref。正落地这条则忽略撤 UI（付费已 commit）。
      if (useCanvasProposalStore.getState().applyingRequestId === payload.requestId) return;
      clearIfStill(payload.requestId);
    });
    return () => {
      unsubscribe?.();
      unsubCancel?.();
    };
  }, [setPending]);

  const apply = useCallback(async (selectedOps?: CanvasProposalOp[]) => {
    const st = useCanvasProposalStore.getState();
    const target = st.pending;
    // R3 HIGH-1：重入闸——已有提议在落地则忽略（防双击 Apply 双付费 / Apply 后又点 Reject）。
    if (!target || st.applyingRequestId) return;
    st.setApplying(target.requestId);
    try {
      return await applyProposal(target, controllerDeps(), selectedOps);
    } finally {
      useCanvasProposalStore.getState().setApplying(null);
      clearIfStill(target.requestId); // R3 MED-2：只清自己这条，别误清并发新提议
    }
  }, []);

  const reject = useCallback(async (feedback?: string) => {
    const st = useCanvasProposalStore.getState();
    const target = st.pending;
    if (!target || st.applyingRequestId) return; // 同闸：落地中不接受 Reject
    st.setApplying(target.requestId);
    try {
      await rejectProposal(target, { respond: controllerDeps().respond }, feedback);
    } finally {
      useCanvasProposalStore.getState().setApplying(null);
      clearIfStill(target.requestId);
    }
  }, []);

  return { pending, applying: applyingRequestId !== null, apply, reject };
}
