// ADR-026 D2-A：待审批画布提议的 renderer 运行态（agent 经 IPC 推来，等用户 Apply/Reject）。
// 只持一个待审批提议（同一时刻 agent 阻塞等一个）；不挂 persist（运行时态）。
import { create } from 'zustand';
import type { CanvasOpProposal } from '../../../shared/contract/canvasProposal';

interface CanvasProposalState {
  pending: CanvasOpProposal | null;
  /**
   * 正在落地（含 Phase B 出图）的提议 requestId；null=空闲（R3 HIGH-1）。
   * 全局单例锁（store 级，跨组件重挂存活），在 apply/reject/cancel/clear 每个边界按 requestId 校验，
   * 防：重复点击 Apply 双付费、在途时 CANCEL 撤 UI、并发提议互相误清。
   */
  applyingRequestId: string | null;
  setPending: (proposal: CanvasOpProposal) => void;
  setApplying: (requestId: string | null) => void;
  clear: () => void;
}

export const useCanvasProposalStore = create<CanvasProposalState>((set) => ({
  pending: null,
  applyingRequestId: null,
  setPending: (proposal) => set({ pending: proposal }),
  setApplying: (requestId) => set({ applyingRequestId: requestId }),
  clear: () => set({ pending: null }),
}));

// E2E/dev 调试钩子：真机测试用 setPending 模拟收到 agent 提议（同 window.__neo* 例）。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoCanvasProposalStore?: typeof useCanvasProposalStore }).__neoCanvasProposalStore =
    useCanvasProposalStore;
}
