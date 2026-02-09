// ============================================================================
// DAG Visualization Types - React Flow 可视化专用类型
// Session 5: React Flow 可视化
// ============================================================================

import type { Node, Edge } from '@xyflow/react';
import type { TaskStatus, TaskPriority, DAGTaskType, TaskOutput, TaskFailure, DAGStatistics, DAGStatus } from './taskDAG';

// ============================================================================
// Node Types
// ============================================================================

/**
 * Task Node 数据
 * Note: Index signature required for React Flow compatibility
 */
export interface TaskNodeData {
  /** 任务 ID */
  taskId: string;
  /** 任务名称 */
  name: string;
  /** 任务描述 */
  description?: string;
  /** 任务类型 */
  type: DAGTaskType;
  /** 当前状态 */
  status: TaskStatus;
  /** 优先级 */
  priority: TaskPriority;
  /** Agent 角色（agent 类型时） */
  role?: string;

  // 时间信息
  /** 开始时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 耗时（毫秒） */
  duration?: number;
  /** 预估耗时（毫秒） */
  estimatedDuration?: number;

  // 执行信息
  /** 重试次数 */
  retryCount: number;
  /** 成本（USD） */
  cost?: number;
  /** 使用的工具 */
  toolsUsed?: string[];
  /** 迭代次数 */
  iterations?: number;

  // 结果
  /** 输出 */
  output?: TaskOutput;
  /** 失败信息 */
  failure?: TaskFailure;

  // 交互
  /** 是否选中 */
  isSelected?: boolean;
  /** 是否高亮 */
  isHighlighted?: boolean;

  /** Index signature for React Flow compatibility */
  [key: string]: unknown;
}

/**
 * React Flow Task Node
 */
export type TaskNode = Node<TaskNodeData, 'task'>;

// ============================================================================
// Edge Types
// ============================================================================

/**
 * Dependency Edge 数据
 * Note: Index signature required for React Flow compatibility
 */
export interface DependencyEdgeData {
  /** 是否在关键路径上 */
  isCriticalPath?: boolean;
  /** 是否激活（数据正在流动） */
  isActive?: boolean;
  /** 依赖类型 */
  dependencyType?: 'data' | 'control' | 'checkpoint';
  /** 边的标签 */
  label?: string;

  /** Index signature for React Flow compatibility */
  [key: string]: unknown;
}

/**
 * React Flow Dependency Edge
 */
export type DependencyEdge = Edge<DependencyEdgeData>;

// ============================================================================
// DAG Visualization State
// ============================================================================

/**
 * DAG 可视化状态
 */
export interface DAGVisualizationState {
  /** DAG ID */
  dagId: string;
  /** DAG 名称 */
  name: string;
  /** DAG 描述 */
  description?: string;
  /** DAG 执行状态 */
  status: DAGStatus;
  /** 统计信息 */
  statistics: DAGStatistics;
  /** 节点列表 */
  nodes: TaskNode[];
  /** 边列表 */
  edges: DependencyEdge[];
  /** 关键路径 */
  criticalPath?: string[];
  /** 开始时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 错误信息 */
  error?: string;
}

// ============================================================================
// Events for IPC
// ============================================================================

/**
 * DAG 可视化事件类型
 */
export type DAGVisualizationEventType =
  | 'dag:init'           // DAG 初始化
  | 'dag:start'          // DAG 开始执行
  | 'dag:complete'       // DAG 执行完成
  | 'dag:failed'         // DAG 执行失败
  | 'dag:cancelled'      // DAG 被取消
  | 'task:status'        // 任务状态变化
  | 'task:progress'      // 任务进度更新
  | 'statistics:update'; // 统计信息更新

/**
 * DAG 可视化事件
 */
export interface DAGVisualizationEvent {
  type: DAGVisualizationEventType;
  dagId: string;
  timestamp: number;
  data: DAGVisualizationEventData;
}

/**
 * 事件数据联合类型
 */
export type DAGVisualizationEventData =
  | DAGInitEventData
  | DAGStatusEventData
  | TaskStatusEventData
  | TaskProgressEventData
  | StatisticsUpdateEventData;

/**
 * DAG 初始化事件数据
 */
export interface DAGInitEventData {
  type: 'dag:init';
  state: DAGVisualizationState;
}

/**
 * DAG 状态事件数据
 */
export interface DAGStatusEventData {
  type: 'dag:start' | 'dag:complete' | 'dag:failed' | 'dag:cancelled';
  status: DAGStatus;
  error?: string;
  statistics?: DAGStatistics;
}

/**
 * 任务状态事件数据
 */
export interface TaskStatusEventData {
  type: 'task:status';
  taskId: string;
  status: TaskStatus;
  output?: TaskOutput;
  failure?: TaskFailure;
  startedAt?: number;
  completedAt?: number;
  duration?: number;
  cost?: number;
}

/**
 * 任务进度事件数据
 */
export interface TaskProgressEventData {
  type: 'task:progress';
  taskId: string;
  iterations?: number;
  toolsUsed?: string[];
  cost?: number;
}

/**
 * 统计信息更新事件数据
 */
export interface StatisticsUpdateEventData {
  type: 'statistics:update';
  statistics: DAGStatistics;
}

// ============================================================================
// Layout Options
// ============================================================================

/**
 * 布局方向
 */
export type LayoutDirection = 'TB' | 'BT' | 'LR' | 'RL';

/**
 * 布局配置
 */
export interface DAGLayoutOptions {
  /** 布局方向 */
  direction: LayoutDirection;
  /** 节点间距（水平） */
  nodeSpacing: number;
  /** 层级间距（垂直） */
  rankSpacing: number;
  /** 是否居中 */
  centerGraph: boolean;
  /** 是否自动适应视口 */
  fitView: boolean;
}

/**
 * 默认布局配置
 */
export const DEFAULT_LAYOUT_OPTIONS: DAGLayoutOptions = {
  direction: 'TB',
  nodeSpacing: 80,
  rankSpacing: 100,
  centerGraph: true,
  fitView: true,
};

// ============================================================================
// Styling
// ============================================================================

/**
 * 任务状态对应的颜色
 */
export const TASK_STATUS_COLORS: Record<TaskStatus, { bg: string; border: string; text: string }> = {
  pending: { bg: '#374151', border: '#4B5563', text: '#9CA3AF' },   // gray
  ready: { bg: '#1E3A5F', border: '#3B82F6', text: '#93C5FD' },     // blue
  running: { bg: '#1E40AF', border: '#3B82F6', text: '#FFFFFF' },   // bright blue
  completed: { bg: '#065F46', border: '#10B981', text: '#6EE7B7' }, // green
  failed: { bg: '#7F1D1D', border: '#EF4444', text: '#FCA5A5' },    // red
  cancelled: { bg: '#44403C', border: '#78716C', text: '#A8A29E' }, // stone
  skipped: { bg: '#3F3F46', border: '#71717A', text: '#A1A1AA' },   // zinc
};

/**
 * 任务类型对应的图标
 */
export const TASK_TYPE_ICONS: Record<DAGTaskType, string> = {
  agent: '🤖',
  workflow: '📋',
  function: '⚡',
  shell: '💻',
  parallel: '⚡⚡',
  conditional: '❓',
  checkpoint: '🏁',
  evaluate: '⚖️',
};

/**
 * 优先级对应的徽章颜色
 */
export const PRIORITY_BADGE_COLORS: Record<TaskPriority, string> = {
  low: '#6B7280',
  normal: '#3B82F6',
  high: '#F59E0B',
  critical: '#EF4444',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 格式化持续时间（从共享工具导入）
 */
export { formatDuration } from '../utils/format';

/**
 * 格式化成本
 */
export function formatCost(usd: number): string {
  if (usd < 0.001) return '< $0.001';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * 获取任务状态的动画类名
 */
export function getStatusAnimationClass(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'animate-pulse';
    case 'ready':
      return 'animate-bounce-subtle';
    default:
      return '';
  }
}

/**
 * 计算进度百分比
 */
export function calculateProgress(statistics: DAGStatistics): number {
  const { totalTasks, completedTasks, failedTasks, skippedTasks, cancelledTasks = 0 } = statistics as DAGStatistics & { cancelledTasks?: number };
  const finishedTasks = completedTasks + failedTasks + skippedTasks + cancelledTasks;
  return totalTasks > 0 ? Math.round((finishedTasks / totalTasks) * 100) : 0;
}
