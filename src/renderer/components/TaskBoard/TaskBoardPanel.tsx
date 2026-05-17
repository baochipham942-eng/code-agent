// ============================================================================
// TaskBoardPanel - 跨 workspace MasterTask 列表视图
// ============================================================================
//
// 第 6 个 workbench tab。展示当前用户所有 MasterTask（含终态历史），按
// updatedAt 倒序排列。支持按 status / workspace 双重过滤。
//
// 设计约束:
//   - 不展示 plan markdown / agentTask 子节点（详情页 P2-c2 才用）
//   - actions（pause/resume/cancel）按 status 条件显示
//   - MasterTaskDTO 当前没有 updatedAt 字段，临时按 id 倒序（最近创建的排前）
// ============================================================================

import React, { useEffect, useMemo } from 'react';
import { Pause, Play, X as XIcon, AlertCircle } from 'lucide-react';
import type { MasterTaskDTO, MasterTaskStatus } from '@shared/contract/task';
import { MASTER_TASK_STATUSES } from '@shared/contract/task';
import { useMasterTaskStore } from '../../stores/masterTaskStore';
import { TaskDetailPanel } from './TaskDetailPanel';

// ----------------------------------------------------------------------------
// 状态徽章配色
// ----------------------------------------------------------------------------

function statusBadgeClass(status: MasterTaskStatus): string {
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
// helpers
// ----------------------------------------------------------------------------

function workspaceBasename(uri: string): string {
  if (!uri) return '—';
  // 兼容 file:// 前缀和裸路径
  const clean = uri.replace(/^file:\/\//, '');
  const segments = clean.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : uri;
}

// 终态：UI 不再提供操作按钮
const TERMINAL: ReadonlySet<MasterTaskStatus> = new Set([
  'completed',
  'done',
  'cancelled',
  'failed',
  'error',
]);

// ----------------------------------------------------------------------------
// Row
// ----------------------------------------------------------------------------

interface TaskRowProps {
  task: MasterTaskDTO;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}

const TaskRow: React.FC<TaskRowProps> = ({
  task,
  isSelected,
  onSelect,
  onPause,
  onResume,
  onCancel,
}) => {
  const isTerminal = TERMINAL.has(task.status);
  const canPause = task.status === 'running';
  const canResume = task.status === 'paused';
  const canCancel = !isTerminal;

  // action button click 必须 stopPropagation —— 否则触发 row onClick 切换详情
  // 而 pause/resume/cancel 不应附带选中副作用
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      data-testid="task-row"
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task.id);
        }
      }}
      className={`flex items-start gap-3 px-3 py-2.5 border-b border-zinc-800/60 cursor-pointer transition-colors ${
        isSelected ? 'bg-blue-500/10' : 'hover:bg-zinc-800/30'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border ${statusBadgeClass(
              task.status,
            )}`}
          >
            {task.status}
          </span>
          <span className="text-sm text-zinc-100 truncate" title={task.title}>
            {task.title || 'Unnamed task'}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-zinc-500 truncate">
          <span title={task.workspaceUri}>{workspaceBasename(task.workspaceUri)}</span>
          <span className="text-zinc-700">·</span>
          <span className="font-mono text-[10px]">{task.id.slice(0, 8)}</span>
        </div>
        {task.error && (
          <div
            className="mt-1 flex items-start gap-1 text-[11px] text-rose-400"
            title={task.error}
          >
            <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span className="truncate">{task.error}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        {canPause && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onPause(task.id);
            }}
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 transition-colors"
            title="暂停"
            aria-label="pause"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
        )}
        {canResume && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onResume(task.id);
            }}
            className="p-1 rounded text-zinc-400 hover:text-emerald-300 hover:bg-zinc-700/60 transition-colors"
            title="继续"
            aria-label="resume"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onCancel(task.id);
            }}
            className="p-1 rounded text-zinc-400 hover:text-rose-300 hover:bg-zinc-700/60 transition-colors"
            title="取消"
            aria-label="cancel"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Filters
// ----------------------------------------------------------------------------

interface FiltersProps {
  filterStatus: ReturnType<typeof useMasterTaskStore.getState>['filterStatus'];
  filterWorkspace: ReturnType<typeof useMasterTaskStore.getState>['filterWorkspace'];
  workspaces: string[];
  onChangeStatus: (status: ReturnType<typeof useMasterTaskStore.getState>['filterStatus']) => void;
  onChangeWorkspace: (
    workspace: ReturnType<typeof useMasterTaskStore.getState>['filterWorkspace'],
  ) => void;
}

const Filters: React.FC<FiltersProps> = ({
  filterStatus,
  filterWorkspace,
  workspaces,
  onChangeStatus,
  onChangeWorkspace,
}) => (
  <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 text-xs">
    <label className="text-zinc-500">状态</label>
    <select
      value={filterStatus}
      onChange={(e) => onChangeStatus(e.target.value as typeof filterStatus)}
      className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200"
    >
      <option value="all">全部</option>
      {MASTER_TASK_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>

    <label className="text-zinc-500 ml-2">Workspace</label>
    <select
      value={filterWorkspace}
      onChange={(e) => onChangeWorkspace(e.target.value as typeof filterWorkspace)}
      className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 max-w-[200px] truncate"
    >
      <option value="all">全部</option>
      {workspaces.map((uri) => (
        <option key={uri} value={uri} title={uri}>
          {workspaceBasename(uri)}
        </option>
      ))}
    </select>
  </div>
);

// ----------------------------------------------------------------------------
// Panel
// ----------------------------------------------------------------------------

export const TaskBoardPanel: React.FC = () => {
  const tasks = useMasterTaskStore((s) => s.tasks);
  const filterStatus = useMasterTaskStore((s) => s.filterStatus);
  const filterWorkspace = useMasterTaskStore((s) => s.filterWorkspace);
  const loading = useMasterTaskStore((s) => s.loading);
  const error = useMasterTaskStore((s) => s.error);
  const selectedTaskId = useMasterTaskStore((s) => s.selectedTaskId);
  const load = useMasterTaskStore((s) => s.load);
  const pause = useMasterTaskStore((s) => s.pause);
  const resume = useMasterTaskStore((s) => s.resume);
  const cancel = useMasterTaskStore((s) => s.cancel);
  const selectTask = useMasterTaskStore((s) => s.selectTask);
  const setFilterStatus = useMasterTaskStore((s) => s.setFilterStatus);
  const setFilterWorkspace = useMasterTaskStore((s) => s.setFilterWorkspace);

  // 进入面板时 load 一次；后续靠 IPC event 增量
  useEffect(() => {
    void load();
  }, [load]);

  const workspaces = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.workspaceUri) set.add(t.workspaceUri);
    }
    return Array.from(set).sort();
  }, [tasks]);

  const filtered = useMemo(() => {
    const list = tasks
      .filter((t) => filterStatus === 'all' || t.status === filterStatus)
      .filter((t) => filterWorkspace === 'all' || t.workspaceUri === filterWorkspace)
      // MasterTaskDTO 没有 updatedAt —— 按 id 倒序近似最新优先（uuid v4 不保证
      // 时间序，但同会话内通常对齐）。后续 P2 在 DTO 加 updatedAt 后改成时间序。
      .slice()
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return list;
  }, [tasks, filterStatus, filterWorkspace]);

  return (
    <div className="flex h-full bg-zinc-950 text-zinc-200" data-testid="task-board-panel">
      {/* 左栏：列表（选中时收窄到一半，否则占满）*/}
      <div
        className={`flex flex-col min-h-0 ${
          selectedTaskId ? 'w-1/2 border-r border-zinc-800' : 'flex-1'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">任务看板</span>
            <span className="text-[11px] text-zinc-500">
              {filtered.length}/{tasks.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-[11px] px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
            title="刷新"
          >
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>

        <Filters
          filterStatus={filterStatus}
          filterWorkspace={filterWorkspace}
          workspaces={workspaces}
          onChangeStatus={setFilterStatus}
          onChangeWorkspace={setFilterWorkspace}
        />

        {/* Error banner */}
        {error && (
          <div className="px-3 py-1.5 text-[11px] text-rose-300 bg-rose-500/10 border-b border-rose-500/30">
            {error}
          </div>
        )}

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filtered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-full text-zinc-500 text-xs"
              data-testid="task-board-empty"
            >
              <span>暂无任务</span>
              <span className="mt-1 text-[10px] text-zinc-600">
                {tasks.length === 0 ? '尚未创建任何 MasterTask' : '当前过滤条件下无匹配项'}
              </span>
            </div>
          ) : (
            filtered.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isSelected={selectedTaskId === task.id}
                onSelect={selectTask}
                onPause={pause}
                onResume={resume}
                onCancel={cancel}
              />
            ))
          )}
        </div>
      </div>

      {/* 右栏：详情面板 */}
      {selectedTaskId && (
        <div className="w-1/2 min-h-0">
          <TaskDetailPanel taskId={selectedTaskId} onClose={() => selectTask(null)} />
        </div>
      )}
    </div>
  );
};

export default TaskBoardPanel;
