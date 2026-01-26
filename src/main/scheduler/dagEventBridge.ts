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
} from '../../shared/types/dagVisualization';
import type { DAGEvent, DAGEventType, DAGStatistics } from '../../shared/types/taskDAG';
import { getDAGScheduler } from './DAGScheduler';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DAGEventBridge');

let bridgeInitialized = false;

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
 * 手动发送 DAG 初始化事件
 * 用于在 DAG 创建后立即通知渲染进程
 */
export function sendDAGInitEvent(
  dagId: string,
  _dagName: string,
  tasks: Array<{ id: string; name: string; type: string; status: string; dependencies: string[] }>
): void {
  const statistics: DAGStatistics = {
    totalTasks: tasks.length,
    completedTasks: 0,
    failedTasks: 0,
    pendingTasks: tasks.length,
    runningTasks: 0,
    skippedTasks: 0,
    readyTasks: 0,
    totalDuration: 0,
    totalCost: 0,
    maxParallelism: 0,
  };

  const event: DAGVisualizationEvent = {
    type: 'dag:start',
    dagId,
    timestamp: Date.now(),
    data: {
      type: 'dag:start',
      status: 'running',
      statistics,
    },
  };

  sendToRenderer(event);
  logger.debug('DAG init event sent', { dagId, taskCount: tasks.length });
}
