// ============================================================================
// Task Panel View Store - 右栏 TaskPanel 的页签选中态（N-L6-AGENTVIEW）
// ----------------------------------------------------------------------------
// 原来是 TaskPanel 组件内 useState，成员条折叠 chip 要从外面把页签切到
// 「本会话的代理」，故提为自洽小 store（appStore 已顶到 max-lines，不塞那边）。
// ============================================================================

import { create } from 'zustand';

export type TaskPanelView = 'overview' | 'inspector' | 'agents';

interface TaskPanelViewState {
  view: TaskPanelView;
  setView: (view: TaskPanelView) => void;
}

export const useTaskPanelViewStore = create<TaskPanelViewState>()((set) => ({
  view: 'overview',
  setView: (view) => set({ view }),
}));
