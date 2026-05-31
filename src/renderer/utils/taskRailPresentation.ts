import type { RunUiState, TaskRecord } from '../types/runWorkbench';

export type TaskRailMode = 'simple' | 'checklist';

export interface TaskRailStepView {
  title: string;
  status: TaskRecord['steps'][number]['status'];
  originalIndex: number;
  blockedByTitles?: string[];
  blockedTaskTitles?: string[];
}

export interface TaskRailDependencySummary {
  waitingCount: number;
  unlockingCount: number;
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
  taskCount: number;
  dependencySummary?: TaskRailDependencySummary;
  currentAction?: string;
}

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
      blockedTaskTitles: step.blockedTaskTitles,
    }))
    .filter((step) => step.title && !isUtilityStepTitle(step.title));
}

export function deriveTaskRailView(task: TaskRecord, run?: RunUiState | null): TaskRailView {
  const taskSteps = toStepViews(task);
  const waitingCount = taskSteps.filter((step) => (step.blockedByTitles?.length ?? 0) > 0).length;
  const unlockingCount = taskSteps.filter((step) => (step.blockedTaskTitles?.length ?? 0) > 0).length;
  const dependencySummary = waitingCount > 0 || unlockingCount > 0
    ? { waitingCount, unlockingCount }
    : undefined;
  const completed = taskSteps.filter((step) => step.status === 'completed').length;
  // 进度分母剔除已取消：取消的子任务不计入任务量，否则进度永远到不了 100%
  const total = taskSteps.filter((step) => step.status !== 'cancelled').length;
  const taskCount = taskSteps.length;
  const isChecklist = taskSteps.length >= 2;

  if (!isChecklist) {
    return {
      mode: 'simple',
      title: simpleTitle(task, run),
      status: task.status,
      visibleSteps: [],
      completedSteps: [],
      hiddenCompletedCount: 0,
      hiddenPendingCount: 0,
      completed,
      total,
      taskCount,
      dependencySummary,
      currentAction: task.resumeHint && task.resumeHint !== task.title ? task.resumeHint : undefined,
    };
  }

  return {
    mode: 'checklist',
    title: task.title || runStatusLabel(run) || statusLabel(task.status),
    status: task.status,
    visibleSteps: taskSteps,
    completedSteps: [],
    hiddenCompletedCount: 0,
    hiddenPendingCount: 0,
    completed,
    total,
    taskCount,
    dependencySummary,
    currentAction: task.resumeHint && task.resumeHint !== task.title ? task.resumeHint : undefined,
  };
}
