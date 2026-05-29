// ============================================================================
// Workflow Store —— dynamic-workflow 进度树 + 启动审批实时状态（P3a + P3b）
//
// 消费 main 经 'workflow:event' 通道推来的 ScriptRunEvent，按 runId 分桶折叠成
// ScriptRunSnapshot（多 run 隔离，对齐 scriptRuntime 的多 run 设计——不复用 swarm 单
// active-run 假设）。折叠逻辑是 @shared/contract/scriptRun 的纯函数 reducer，main/renderer
// 共用，保证两端语义一致。WorkflowMonitor 面板按 activeRunId 选当前 run 渲染进度树。
//
// P3b：'workflow:launch:event' 通道推来的 WorkflowLaunchEvent 维护 launchRequests，
// WorkflowLaunchCard 渲染 pending 请求等用户 approve/reject。
// ============================================================================

import { create } from 'zustand';
import {
  applyScriptRunEvent,
  emptyScriptRunSnapshot,
  type ScriptRunEvent,
  type ScriptRunSnapshot,
  type WorkflowLaunchEvent,
  type WorkflowLaunchRequest,
} from '@shared/contract/scriptRun';

export interface WorkflowStore {
  /** runId → 快照。 */
  runs: Record<string, ScriptRunSnapshot>;
  /** 最近一次 run:start 的 runId（面板默认选它渲染）。 */
  activeRunId?: string;
  /** 启动审批请求（按 id upsert，保留已决状态供 UI 收尾）。 */
  launchRequests: WorkflowLaunchRequest[];
  /** 消费单个 ScriptRunEvent，折叠进对应 run 的快照。 */
  handleEvent: (event: ScriptRunEvent) => void;
  /** 消费启动审批事件。 */
  handleLaunchEvent: (event: WorkflowLaunchEvent) => void;
  /** 当前待决的审批请求（最新一条 pending）。 */
  pendingLaunchRequest: () => WorkflowLaunchRequest | undefined;
  /** 清空所有 run + 审批（新会话 / 手动重置）。 */
  clear: () => void;
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  runs: {},
  activeRunId: undefined,
  launchRequests: [],

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

  handleLaunchEvent: (event) => {
    const req = event?.request;
    if (!req || typeof req.id !== 'string') return;
    const { launchRequests } = get();
    const idx = launchRequests.findIndex((r) => r.id === req.id);
    // upsert by id：requested 追加、approved/rejected 更新既有（不重复追加）。
    const next = idx < 0 ? [...launchRequests, req] : launchRequests.map((r, i) => (i === idx ? req : r));
    set({ launchRequests: next });
  },

  pendingLaunchRequest: () => {
    const pending = get().launchRequests.filter((r) => r.status === 'pending');
    return pending.length > 0 ? pending[pending.length - 1] : undefined;
  },

  clear: () => set({ runs: {}, activeRunId: undefined, launchRequests: [] }),
}));
