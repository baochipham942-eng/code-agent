// ============================================================================
// TaskDetailPanel - MasterTask 详情视图（split view 右栏，P2-c2）
// ============================================================================
//
// 点击 TaskBoardPanel 任一行 → 打开此面板，显示：
//   - planProgress markdown (DB baseline + 实时流式 buffer 拼接)
//   - workspace / sessions / sub agents / error 元信息
//
// 设计约束:
//   - 只读视图。pause/resume/cancel 仍在列表行 action 按钮，避免重复入口
//   - 暂时只显示 attachedSessionIds / childAgentTaskIds 字符串 ID，不拉 IPC
//     渲染 session/agent 详情（P2-c4 再做）
//   - planProgress 用 `react-markdown`，prose-invert 主题
// ============================================================================

import React, { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { X as XIcon, AlertCircle, Eye as EyeIcon } from 'lucide-react';
import type { MasterTaskStatus } from '@shared/contract/task';
import { useMasterTaskStore } from '../../stores/masterTaskStore';

// ----------------------------------------------------------------------------
// 状态徽章配色（与 TaskBoardPanel 保持一致 —— 复用风格，inline 一份避免循环依赖）
// ----------------------------------------------------------------------------

function statusBadgeClass(status: MasterTaskStatus | undefined): string {
  switch (status) {
    case 'running':
      return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    case 'review':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'completed':
    case 'done':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'failed':
    case 'error':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'cancelled':
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
    case 'paused':
      return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
    case 'waiting':
    case 'queued':
      return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
    case 'pending':
    case 'created':
    default:
      return 'bg-zinc-700/40 text-zinc-300 border-zinc-600/40';
  }
}

// ----------------------------------------------------------------------------
// 小 building blocks
// ----------------------------------------------------------------------------

interface SectionProps {
  title: string;
  tone?: 'default' | 'error';
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, tone = 'default', children }) => (
  <div className="px-4 py-2 border-t border-zinc-800">
    <div
      className={`text-[10px] uppercase tracking-wider mb-1.5 ${
        tone === 'error' ? 'text-rose-400' : 'text-zinc-500'
      }`}
    >
      {title}
    </div>
    <div className={tone === 'error' ? 'text-xs text-rose-300' : 'text-xs text-zinc-300'}>
      {children}
    </div>
  </div>
);

const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-zinc-600 italic">{children}</span>
);

// ----------------------------------------------------------------------------
// Panel
// ----------------------------------------------------------------------------

export interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
}

export const TaskDetailPanel: React.FC<TaskDetailPanelProps> = ({ taskId, onClose }) => {
  const task = useMasterTaskStore((s) => s.tasks.find((t) => t.id === taskId));
  const planBuffer = useMasterTaskStore((s) => s.planProgressBuffer.get(taskId) ?? '');
  const detailLoading = useMasterTaskStore((s) => s.detailLoading);
  const detailError = useMasterTaskStore((s) => s.detailError);
  const loadTaskDetail = useMasterTaskStore((s) => s.loadTaskDetail);
  const updateStatus = useMasterTaskStore((s) => s.updateStatus);

  // 进入或切换 taskId 时拉一次 detail —— planProgress / childAgentTaskIds /
  // attachedSessionIds 的 DB baseline 可能比 list 时旧，需要 fresh fetch
  useEffect(() => {
    void loadTaskDetail(taskId);
  }, [taskId, loadTaskDetail]);

  // DB baseline + 实时 streaming buffer 拼接
  const fullPlanMarkdown = (task?.planProgress ?? '') + planBuffer;

  return (
    <div
      className="flex flex-col h-full bg-zinc-900 border-l border-zinc-700"
      data-testid="task-detail-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {task?.status && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border flex-shrink-0 ${statusBadgeClass(
                task.status,
              )}`}
            >
              {task.status}
            </span>
          )}
          <h3 className="text-sm font-medium text-zinc-200 truncate" title={task?.title}>
            {task?.title || 'Untitled task'}
          </h3>
        </div>
        {/* P4-c1: 手动标记审查（status='running' 时显示）。
            点击 → master.requestReview()，状态转 running→review，agent 暂停等待人工检视。
            NudgeManager P5/P7 自动 trigger 留 backlog（涉及大改 nudgeManager.ts，scope 外）。*/}
        {task?.status === 'running' && (
          <button
            type="button"
            onClick={() => void updateStatus(taskId, 'review')}
            className="flex items-center gap-1 px-2 py-0.5 mr-2 text-[10px] text-amber-300 hover:bg-amber-500/10 border border-amber-500/30 rounded transition-colors flex-shrink-0"
            title="标记为审查中（暂停执行，等待人工检视）"
            aria-label="mark-review"
          >
            <EyeIcon className="w-3 h-3" />
            <span>标记审查</span>
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
          title="关闭详情"
          aria-label="close-detail"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>

      {/* loading / error banner */}
      {detailLoading && (
        <div className="px-4 py-1.5 text-[11px] text-zinc-500 bg-zinc-900/80 border-b border-zinc-800">
          加载详情中…
        </div>
      )}
      {detailError && (
        <div className="px-4 py-1.5 text-[11px] text-rose-300 bg-rose-500/10 border-b border-rose-500/30 flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span className="truncate">{detailError}</span>
        </div>
      )}

      {/* Content scroll area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* plan markdown */}
        <div className="px-4 py-3" data-testid="task-detail-plan">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Plan Progress
          </div>
          {fullPlanMarkdown ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown>{fullPlanMarkdown}</ReactMarkdown>
            </div>
          ) : (
            <EmptyHint>暂无 plan 内容</EmptyHint>
          )}
        </div>

        {/* workspace */}
        <Section title="Workspace">
          {task?.workspaceUri ? (
            <span className="font-mono text-[11px] break-all" title={task.workspaceUri}>
              {task.workspaceUri}
            </span>
          ) : (
            <EmptyHint>—</EmptyHint>
          )}
        </Section>

        {/* sessions */}
        <Section title="Sessions">
          {task?.attachedSessionIds && task.attachedSessionIds.length > 0 ? (
            <ul className="space-y-1" data-testid="task-detail-sessions">
              {task.attachedSessionIds.map((sid) => (
                <li
                  key={sid}
                  className="font-mono text-[11px] text-zinc-300 truncate"
                  title={sid}
                >
                  {sid}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyHint>暂无关联 session</EmptyHint>
          )}
        </Section>

        {/* sub agents */}
        <Section title="Sub Agents">
          {task?.childAgentTaskIds && task.childAgentTaskIds.length > 0 ? (
            <ul className="space-y-1" data-testid="task-detail-agents">
              {task.childAgentTaskIds.map((aid) => (
                <li
                  key={aid}
                  className="font-mono text-[11px] text-zinc-300 truncate"
                  title={aid}
                >
                  {aid}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyHint>暂无子 agent task</EmptyHint>
          )}
        </Section>

        {/* error */}
        {task?.error && (
          <Section title="Error" tone="error">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
              {task.error}
            </pre>
          </Section>
        )}
      </div>
    </div>
  );
};

export default TaskDetailPanel;
