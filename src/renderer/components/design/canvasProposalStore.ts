// ADR-026 D2-A：待审批画布提议的 renderer 运行态（agent 经 IPC 推来，等用户 Apply/Reject）。
// 只持一个待审批提议（同一时刻 agent 阻塞等一个）；不挂 persist（运行时态）。
import { create } from 'zustand';
import type { CanvasOpProposal } from '../../../shared/contract/canvasProposal';

interface CanvasProposalState {
  pending: CanvasOpProposal | null;
  setPending: (proposal: CanvasOpProposal) => void;
  clear: () => void;
}

export const useCanvasProposalStore = create<CanvasProposalState>((set) => ({
  pending: null,
  setPending: (proposal) => set({ pending: proposal }),
  clear: () => set({ pending: null }),
}));

// E2E/dev 调试钩子：真机测试用 setPending 模拟收到 agent 提议（同 window.__neo* 例）。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoCanvasProposalStore?: typeof useCanvasProposalStore }).__neoCanvasProposalStore =
    useCanvasProposalStore;
}
