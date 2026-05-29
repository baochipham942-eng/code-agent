// ============================================================================
// Workflow Store —— dynamic-workflow 进度树实时状态（P3a）
//
// 消费 main 经 'workflow:event' 通道推来的 ScriptRunEvent，按 runId 分桶折叠成
// ScriptRunSnapshot（多 run 隔离，对齐 scriptRuntime 的多 run 设计——不复用 swarm 单
// active-run 假设）。折叠逻辑是 @shared/contract/scriptRun 的纯函数 reducer，main/renderer
// 共用，保证两端语义一致。WorkflowMonitor 面板按 activeRunId 选当前 run 渲染进度树。
// ============================================================================

import { create } from 'zustand';
import {
  applyScriptRunEvent,
  emptyScriptRunSnapshot,
  type ScriptRunEvent,
  type ScriptRunSnapshot,
} from '@shared/contract/scriptRun';

export interface WorkflowStore {
  /** runId → 快照。 */
  runs: Record<string, ScriptRunSnapshot>;
  /** 最近一次 run:start 的 runId（面板默认选它渲染）。 */
  activeRunId?: string;
  /** 消费单个 ScriptRunEvent，折叠进对应 run 的快照。 */
  handleEvent: (event: ScriptRunEvent) => void;
  /** 清空所有 run（新会话 / 手动重置）。 */
  clear: () => void;
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  runs: {},
  activeRunId: undefined,

  handleEvent: (event) => {
    // 防御脏数据：缺 runId 的事件直接丢（renderer 拿到的是 IPC/SSE 反序列化结果）。
    if (!event || typeof event.runId !== 'string' || event.runId.length === 0) return;
    const { runs, activeRunId } = get();
    const prev = runs[event.runId] ?? emptyScriptRunSnapshot(event.runId);
    const next = applyScriptRunEvent(prev, event);
    set({
      runs: { ...runs, [event.runId]: next },
      // run:start 把 activeRunId 切到最新 run；其余事件不动选中项。
      activeRunId: event.type === 'run:start' ? event.runId : activeRunId,
    });
  },

  clear: () => set({ runs: {}, activeRunId: undefined }),
}));
