import type { RunUiState, TaskRecord } from '../types/runWorkbench';

export type TaskRailMode = 'simple' | 'checklist';

export interface TaskRailStepView {
  title: string;
  status: TaskRecord['steps'][number]['status'];
  originalIndex: number;
  blockedByTitles?: string[];
}

export interface TaskRailView {
  mode: TaskRailMode;
  title: string;
  status: TaskRecord['status'];
  visibleSteps: TaskRailStepView[];
  completedSteps: TaskRailStepView[];
  hiddenCompletedCount: number;
  hiddenPendingCount: number;
  completed: number;
  total: number;
  currentAction?: string;
}

const MAX_VISIBLE_STEPS = 6;

const STATUS_RANK: Record<TaskRecord['steps'][number]['status'], number> = {
  blocked: 0,
  in_progress: 1,
  pending: 2,
  completed: 3,
  cancelled: 4,
};

const UTILITY_STEP_PATTERNS = [
  /^read$/i,
  /^bash$/i,
  /^grep$/i,
  /^search$/i,
  /^工具[:：\s]/,
  /^tool[:：\s]/i,
  /^(读取|读)(文件|代码|目录|仓库|资料|文档)/,
  /^(运行|执行|跑)(命令|脚本|测试|构建)/,
  /^(联网|网络)?搜索(资料|信息|网页)?$/,
  /^调用(工具|接口|MCP)/i,
  /^第\s*\d+\/\d+\s*个工具$/,
  /^(文件读取|文件写入|命令执行|工具调用|搜索)活动$/,
];

function isUtilityStepTitle(title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return true;
  return UTILITY_STEP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function statusLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'blocked':
      return '已阻塞';
    case 'cancelled':
      return '已取消';
    case 'pending':
      return '待开始';
    case 'in_progress':
    default:
      return '正在处理';
  }
}

function runStatusLabel(run?: RunUiState | null): string | null {
  if (!run) return null;
  switch (run.status) {
    case 'completed':
      return '已完成';
    case 'blocked':
      return '已阻塞';
    case 'waiting_approval':
      return '等待审批';
    case 'planning':
      return '正在分析';
    case 'using_tools':
    case 'running':
    case 'verifying':
      return run.phase || '正在处理';
    case 'cancelled':
      return '已取消';
    default:
      return run.phase || null;
  }
}

function simpleTitle(task: TaskRecord, run?: RunUiState | null): string {
  if (task.status === 'completed' || task.status === 'blocked' || task.status === 'cancelled') {
    return statusLabel(task.status);
  }
  return task.title || runStatusLabel(run) || statusLabel(task.status);
}

function toStepViews(task: TaskRecord): TaskRailStepView[] {
  return task.steps
    .map((step, index) => ({
      title: step.title.trim(),
      status: step.status,
      originalIndex: index,
      blockedByTitles: step.blockedByTitles,
    }))
    .filter((step) => step.title && !isUtilityStepTitle(step.title));
}

function sortSteps(steps: TaskRailStepView[]): TaskRailStepView[] {
  return [...steps].sort((a, b) => {
    const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rankDiff !== 0) return rankDiff;
    return a.originalIndex - b.originalIndex;
  });
}

export function deriveTaskRailView(task: TaskRecord, run?: RunUiState | null): TaskRailView {
  const taskSteps = toStepViews(task);
  const isEnded = (status: TaskRailStepView['status']) => status === 'completed' || status === 'cancelled';
  // 已结束区 = 已完成 + 已取消（都折叠展示，靠 dot/样式区分），active 区排除二者
  const completedSteps = sortSteps(taskSteps.filter((step) => isEnded(step.status)));
  const activeSteps = sortSteps(taskSteps.filter((step) => !isEnded(step.status)));
  const completed = taskSteps.filter((step) => step.status === 'completed').length;
  // 进度分母剔除已取消：取消的子任务不计入任务量，否则进度永远到不了 100%
  const total = taskSteps.filter((step) => step.status !== 'cancelled').length;
  const isChecklist = taskSteps.length >= 2;

  if (!isChecklist) {
    return {
      mode: 'simple',
      title: simpleTitle(task, run),
      status: task.status,
      visibleSteps: [],
      completedSteps,
      hiddenCompletedCount: completedSteps.length,
      hiddenPendingCount: 0,
      completed,
      total,
      currentAction: task.resumeHint && task.resumeHint !== task.title ? task.resumeHint : undefined,
    };
  }

  const isAllDone = activeSteps.length === 0 && completedSteps.length > 0;
  const visibleSteps = (isAllDone ? completedSteps : activeSteps).slice(0, MAX_VISIBLE_STEPS);
  const foldedCompletedSteps = isAllDone ? completedSteps.slice(MAX_VISIBLE_STEPS) : completedSteps;
  const hiddenPendingCount = isAllDone ? 0 : Math.max(0, activeSteps.length - visibleSteps.length);

  return {
    mode: 'checklist',
    title: task.title || runStatusLabel(run) || statusLabel(task.status),
    status: task.status,
    visibleSteps,
    completedSteps: foldedCompletedSteps,
    hiddenCompletedCount: foldedCompletedSteps.length,
    hiddenPendingCount,
    completed,
    total,
    currentAction: task.resumeHint && task.resumeHint !== task.title ? task.resumeHint : undefined,
  };
}
