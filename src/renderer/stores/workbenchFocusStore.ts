// 专注模式（2026-08-01 工单①）：右栏占满窗口宽度、聊天列收起。
// 独立小 store 而不塞进 appStore——appStore 已贴 god-file 棘轮红线（effective 1000），
// 且这份状态只是布局瞬时态：不持久化，初值恒 false（侧栏态），刷新/重启永远回侧栏态。
import { create } from 'zustand';

interface WorkbenchFocusState {
  /** 专注态开关。布局侧只在右栏可见时认它（见 App.workbenchFocusActive）。 */
  workbenchFocused: boolean;
  setWorkbenchFocused: (focused: boolean) => void;
}

export const useWorkbenchFocusStore = create<WorkbenchFocusState>()((set) => ({
  workbenchFocused: false,
  setWorkbenchFocused: (focused) => set({ workbenchFocused: focused }),
}));
