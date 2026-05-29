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
  type RunStatus,
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
  /**
   * 当前待决的审批请求（最新一条 pending）。给 sessionId 则只返回该会话的（会话隔离，
   * Codex R1 HIGH#1）；缺 sessionId 的请求（dev/headless 注入）对任意会话可见。
   */
  pendingLaunchRequest: (currentSessionId?: string) => WorkflowLaunchRequest | undefined;
  /** 当前 active run 的快照，按会话过滤（同上隔离规则）。 */
  activeSnapshot: (currentSessionId?: string) => ScriptRunSnapshot | undefined;
  /** 清空所有 run + 审批（新会话 / 手动重置）。 */
  clear: () => void;
}

/**
 * 会话隔离判定（Codex R2 HIGH#1：fail-closed）：
 *   - item 无 sessionId（dev/headless 注入）→ 对任意会话可见；
 *   - item 有 sessionId 但当前会话未知（启动/切换空窗）→ 隐藏（fail-closed，不放别人内容出来）；
 *   - 否则需相等。
 */
function visibleInSession(itemSessionId: string | undefined, currentSessionId: string | undefined): boolean {
  if (!itemSessionId) return true;
  if (!currentSessionId) return false; // 会话绑定 item + 当前会话未知 → fail-closed 隐藏
  return itemSessionId === currentSessionId;
}

// 容量上限（Codex R3 MED）：renderer store 跨会话常驻，长跑会无限积。裁剪已完结的 run / 已决的审批。
const MAX_RUNS = 50;
const MAX_RESOLVED_LAUNCH = 20;
const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set<RunStatus>(['completed', 'failed', 'cancelled']);

/** 超上限时按插入序裁掉最旧的【已完结】run，绝不裁 activeRunId / 仍在跑的 run。 */
function pruneRuns(runs: Record<string, ScriptRunSnapshot>, activeRunId?: string): Record<string, ScriptRunSnapshot> {
  const ids = Object.keys(runs);
  if (ids.length <= MAX_RUNS) return runs;
  const dropCount = ids.length - MAX_RUNS;
  const next = { ...runs };
  let dropped = 0;
  for (const id of ids) { // Object.keys 保插入序，最旧在前
    if (dropped >= dropCount) break;
    if (id === activeRunId) continue;
    if (TERMINAL_RUN.has(next[id].status)) { delete next[id]; dropped++; }
  }
  return next;
}

/** 保留所有 pending + 最近 MAX_RESOLVED_LAUNCH 条已决请求。 */
function pruneLaunchRequests(list: WorkflowLaunchRequest[]): WorkflowLaunchRequest[] {
  const pending = list.filter((r) => r.status === 'pending');
  const resolved = list.filter((r) => r.status !== 'pending');
  if (resolved.length <= MAX_RESOLVED_LAUNCH) return list;
  const keptResolved = resolved.slice(resolved.length - MAX_RESOLVED_LAUNCH);
  // 维持原相对顺序：按原 list 过滤出 pending ∪ keptResolved。
  const keepSet = new Set([...pending, ...keptResolved]);
  return list.filter((r) => keepSet.has(r));
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
    // run:start 把 activeRunId 切到最新 run；其余事件不动选中项。
    const nextActive = event.type === 'run:start' ? event.runId : activeRunId;
    set({
      runs: pruneRuns({ ...runs, [event.runId]: next }, nextActive),
      activeRunId: nextActive,
    });
  },

  handleLaunchEvent: (event) => {
    const req = event?.request;
    if (!req || typeof req.id !== 'string') return;
    const { launchRequests } = get();
    const idx = launchRequests.findIndex((r) => r.id === req.id);
    // upsert by id：requested 追加、approved/rejected 更新既有（不重复追加）。
    const next = idx < 0 ? [...launchRequests, req] : launchRequests.map((r, i) => (i === idx ? req : r));
    set({ launchRequests: pruneLaunchRequests(next) });
  },

  pendingLaunchRequest: (currentSessionId) => {
    const pending = get().launchRequests.filter(
      (r) => r.status === 'pending' && visibleInSession(r.sessionId, currentSessionId),
    );
    return pending.length > 0 ? pending[pending.length - 1] : undefined;
  },

  activeSnapshot: (currentSessionId) => {
    const { runs, activeRunId } = get();
    const active = activeRunId ? runs[activeRunId] : undefined;
    if (active && visibleInSession(active.sessionId, currentSessionId)) return active;
    // activeRunId 属别的会话 → 退而找本会话最近一个 running/failed run。
    const visible = Object.values(runs).filter(
      (s) => visibleInSession(s.sessionId, currentSessionId) && (s.status === 'running' || s.status === 'failed'),
    );
    return visible.length > 0 ? visible[visible.length - 1] : undefined;
  },

  clear: () => set({ runs: {}, activeRunId: undefined, launchRequests: [] }),
}));
