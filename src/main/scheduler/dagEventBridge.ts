// ============================================================================
// DAG Event Bridge - Forwards DAG events to renderer process
// ============================================================================

import { BrowserWindow } from 'electron';
import { DAG_CHANNELS } from '../../shared/ipc/channels';
import type {
  DAGVisualizationEvent,
  DAGVisualizationEventType,
  DAGStatusEventData,
  TaskStatusEventData,
  StatisticsUpdateEventData,
  DAGVisualizationState,
  TaskNode,
  DependencyEdge,
  TaskNodeData,
  DAGInitEventData,
} from '../../shared/types/dagVisualization';
import type { DAGEvent, DAGEventType, DAGStatistics, DAGTask } from '../../shared/types/taskDAG';
import { getDAGScheduler } from './DAGScheduler';
import { TaskDAG } from './TaskDAG';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DAGEventBridge');

let bridgeInitialized = false;

// ============================================================================
// DAG → Visualization State Conversion
// ============================================================================

/**
 * 从 TaskDAG 构建可视化状态
 * 将内部 DAG 数据结构转换为 React Flow 可用的节点和边
 */
export function buildDAGVisualizationState(dag: TaskDAG): DAGVisualizationState {
  const tasks = dag.getAllTasks();
  const levels = dag.getExecutionLevels();

  // 构建层级位置映射
  const taskLevelMap = new Map<string, { level: number; index: number }>();
  levels.forEach((level, levelIndex) => {
    level.forEach((taskId, taskIndex) => {
      taskLevelMap.set(taskId, { level: levelIndex, index: taskIndex });
    });
  });

  // 布局参数
  const NODE_WIDTH = 200;
  const NODE_HEIGHT = 80;
  const HORIZONTAL_GAP = 100;
  const VERTICAL_GAP = 120;

  // 构建节点
  const nodes: TaskNode[] = tasks.map((task) => {
    const position = taskLevelMap.get(task.id) || { level: 0, index: 0 };
    const levelTasks = levels[position.level] || [];
    const levelWidth = levelTasks.length * (NODE_WIDTH + HORIZONTAL_GAP) - HORIZONTAL_GAP;

    // 居中布局
    const startX = -levelWidth / 2;
    const x = startX + position.index * (NODE_WIDTH + HORIZONTAL_GAP);
    const y = position.level * (NODE_HEIGHT + VERTICAL_GAP);

    const nodeData: TaskNodeData = {
      taskId: task.id,
      name: task.name,
      description: task.description,
      type: task.type,
      status: task.status,
      priority: task.priority,
      role: task.type === 'agent' ? (task.config as { role?: string }).role : undefined,
      startedAt: task.metadata.startedAt,
      completedAt: task.metadata.completedAt,
      duration: task.metadata.duration,
      estimatedDuration: task.metadata.estimatedDuration,
      retryCount: task.metadata.retryCount,
      cost: task.metadata.cost,
      toolsUsed: task.output?.toolsUsed,
      iterations: task.output?.iterations,
      output: task.output,
      failure: task.failure,
      isSelected: false,
      isHighlighted: false,
    };

    return {
      id: task.id,
      type: 'task',
      position: { x, y },
      data: nodeData,
    };
  });

  // 构建边（依赖关系）
  const edges: DependencyEdge[] = [];
  let edgeId = 0;

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      edges.push({
        id: `edge-${edgeId++}`,
        source: depId,
        target: task.id,
        type: 'smoothstep',
        animated: false,
        data: {
          isCriticalPath: false,
          isActive: false,
          dependencyType: task.type === 'checkpoint' ? 'checkpoint' : 'data',
        },
      });
    }
  }

  // 标记关键路径
  try {
    const criticalPath = dag.getCriticalPath();
    for (let i = 0; i < criticalPath.length - 1; i++) {
      const sourceId = criticalPath[i];
      const targetId = criticalPath[i + 1];
      const edge = edges.find(e => e.source === sourceId && e.target === targetId);
      if (edge && edge.data) {
        edge.data.isCriticalPath = true;
      }
    }
  } catch {
    // 忽略关键路径计算错误
  }

  const state = dag.getState();

  return {
    dagId: dag.getId(),
    name: dag.getName(),
    description: state.definition.description,
    status: state.status,
    statistics: state.statistics,
    nodes,
    edges,
    criticalPath: dag.getCriticalPath(),
    startedAt: state.startedAt,
    completedAt: state.completedAt,
  };
}

/**
 * 将内部 DAGEventType 映射到可视化 DAGVisualizationEventType
 */
function mapEventType(internalType: DAGEventType): DAGVisualizationEventType | null {
  const mapping: Partial<Record<DAGEventType, DAGVisualizationEventType>> = {
    'dag:start': 'dag:start',
    'dag:complete': 'dag:complete',
    'dag:failed': 'dag:failed',
    'dag:cancelled': 'dag:cancelled',
    'task:start': 'task:status',
    'task:complete': 'task:status',
    'task:failed': 'task:status',
    'task:cancelled': 'task:status',
    'task:skipped': 'task:status',
    'task:ready': 'task:status',
    'task:retry': 'task:status',
    'progress:update': 'statistics:update',
  };
  return mapping[internalType] || null;
}

/**
 * 将 DAG 内部事件转换为渲染进程可视化事件
 */
function toVisualizationEvent(event: DAGEvent): DAGVisualizationEvent | null {
  const vizType = mapEventType(event.type);
  if (!vizType) {
    return null;
  }

  // 根据事件类型构建不同的 data 结构
  let data: DAGVisualizationEvent['data'];

  if (vizType === 'dag:start' || vizType === 'dag:complete' || vizType === 'dag:failed' || vizType === 'dag:cancelled') {
    // DAG 状态事件
    const statusData: DAGStatusEventData = {
      type: vizType,
      status: vizType === 'dag:start' ? 'running' :
              vizType === 'dag:complete' ? 'completed' :
              vizType === 'dag:failed' ? 'failed' : 'cancelled',
    };
    if (vizType === 'dag:failed' && event.data && typeof event.data === 'object' && 'error' in event.data) {
      statusData.error = String((event.data as { error?: unknown }).error);
    }
    data = statusData;
  } else if (vizType === 'task:status') {
    // 任务状态事件
    const taskStatus = event.type.replace('task:', '');
    const taskData: TaskStatusEventData = {
      type: 'task:status',
      taskId: event.taskId || '',
      status: taskStatus === 'start' ? 'running' :
              taskStatus === 'complete' ? 'completed' :
              taskStatus === 'retry' ? 'running' :
              taskStatus as 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped',
    };
    data = taskData;
  } else if (vizType === 'statistics:update') {
    // 统计更新事件
    const stats = event.data as DAGStatistics | undefined;
    const statisticsData: StatisticsUpdateEventData = {
      type: 'statistics:update',
      statistics: stats || {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        pendingTasks: 0,
        runningTasks: 0,
        skippedTasks: 0,
        readyTasks: 0,
        totalDuration: 0,
        totalCost: 0,
        maxParallelism: 0,
      },
    };
    data = statisticsData;
  } else {
    return null;
  }

  return {
    type: vizType,
    dagId: event.dagId,
    timestamp: event.timestamp,
    data,
  };
}

/**
 * 发送事件到所有渲染进程窗口
 */
function sendToRenderer(event: DAGVisualizationEvent): void {
  const windows = BrowserWindow.getAllWindows();

  for (const win of windows) {
    if (!win.isDestroyed() && win.webContents) {
      try {
        win.webContents.send(DAG_CHANNELS.EVENT, event);
      } catch (error) {
        logger.warn('Failed to send DAG event to window', {
          windowId: win.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }
}

/**
 * 初始化 DAG 事件桥接
 * 将 DAGScheduler 的 EventEmitter 事件转发到渲染进程
 */
export function initDAGEventBridge(): void {
  if (bridgeInitialized) {
    logger.debug('DAG event bridge already initialized');
    return;
  }

  const scheduler = getDAGScheduler();

  // 需要转发的事件类型
  const eventTypes: DAGEventType[] = [
    'dag:start',
    'dag:complete',
    'dag:failed',
    'dag:cancelled',
    'dag:paused',
    'dag:resumed',
    'task:ready',
    'task:start',
    'task:complete',
    'task:failed',
    'task:retry',
    'task:cancelled',
    'task:skipped',
    'progress:update',
  ];

  // 注册事件监听器
  for (const eventType of eventTypes) {
    scheduler.on(eventType, (event: DAGEvent) => {
      const vizEvent = toVisualizationEvent(event);
      if (vizEvent) {
        sendToRenderer(vizEvent);

        logger.debug('DAG event forwarded to renderer', {
          type: eventType,
          dagId: event.dagId,
          taskId: event.taskId,
        });
      }
    });
  }

  bridgeInitialized = true;
  logger.info('DAG event bridge initialized');
}

/**
 * 发送 DAG 初始化事件
 * 在 DAG 开始执行时调用，将完整的可视化状态发送到渲染进程
 */
export function sendDAGInitEvent(dag: TaskDAG): void {
  const visualizationState = buildDAGVisualizationState(dag);

  const initData: DAGInitEventData = {
    type: 'dag:init',
    state: visualizationState,
  };

  const event: DAGVisualizationEvent = {
    type: 'dag:init',
    dagId: dag.getId(),
    timestamp: Date.now(),
    data: initData,
  };

  sendToRenderer(event);
  logger.info('DAG init event sent', {
    dagId: dag.getId(),
    taskCount: visualizationState.nodes.length,
    edgeCount: visualizationState.edges.length,
  });
}
