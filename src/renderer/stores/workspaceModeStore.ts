// ============================================================================
// Workspace Mode Store —— 顶层工作区切换（Code / 设计）
// ============================================================================
//
// Kun 借鉴：顶部 Code/设计 两个 tab。设计模式是一个全屏工作区（复用
// FullScreenPage 范式覆盖在 Code 之上），Code 模式即现有三列布局，行为不变。
// 单独成 store，避免堆进已偏大的 appStore（遵 god-file 拆分纪律）。
// 详见 内部文档。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WorkspaceMode = 'code' | 'design';

interface WorkspaceModeState {
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
}

export const useWorkspaceModeStore = create<WorkspaceModeState>()(
  persist(
    (set) => ({
      workspaceMode: 'code',
      setWorkspaceMode: (workspaceMode) => set({ workspaceMode }),
    }),
    { name: 'code-agent-workspace-mode', version: 1 },
  ),
);

// E2E/dev 调试钩子：真机测试切设计模式用（dev 构建注入，同 window.__neo* 例）。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoWorkspaceModeStore?: typeof useWorkspaceModeStore }).__neoWorkspaceModeStore =
    useWorkspaceModeStore;
}
