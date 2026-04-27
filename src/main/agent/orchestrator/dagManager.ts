// ============================================================================
// DAG Status Management - Visualization event helpers
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { DAGVisualizationEvent, TaskStatusEventData } from '../../../shared/contract/dagVisualization';

/**
 * 根据 AgentEvent 类型生成对应的 DAG 任务状态更新
 * @returns TaskStatusEventData or null if event type doesn't map to a status update
 */
export function mapAgentEventToDAGStatus(event: AgentEvent): TaskStatusEventData | null {
  switch (event.type) {
    case 'turn_start':
      return {
        type: 'task:status',
        taskId: 'main',
        status: 'running',
        startedAt: Date.now(),
      };

    case 'agent_complete':
      return {
        type: 'task:status',
        taskId: 'main',
        status: 'completed',
        completedAt: Date.now(),
      };

    case 'agent_cancelled':
      return {
        type: 'task:status',
        taskId: 'main',
        status: 'cancelled',
        completedAt: Date.now(),
      };

    case 'error':
      return {
        type: 'task:status',
        taskId: 'main',
        status: 'failed',
        completedAt: Date.now(),
      };

    default:
      return null;
  }
}

/**
 * 将 auto agent 进度状态映射为 DAG task 状态
 */
export function mapAutoAgentStatusToDAGStatus(
  agentId: string,
  status: string
): TaskStatusEventData {
  let taskStatus: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

  switch (status) {
    case 'pending':
    case 'queued':
      taskStatus = 'pending';
      break;
    case 'running':
    case 'executing':
      taskStatus = 'running';
      break;
    case 'completed':
    case 'done':
    case 'success':
      taskStatus = 'completed';
      break;
    case 'failed':
    case 'error':
      taskStatus = 'failed';
      break;
    case 'cancelled':
    case 'stopped':
      taskStatus = 'cancelled';
      break;
    case 'skipped':
      taskStatus = 'skipped';
      break;
    default:
      taskStatus = 'running';
  }

  return {
    type: 'task:status',
    taskId: agentId,
    status: taskStatus,
    ...(taskStatus === 'running' ? { startedAt: Date.now() } : {}),
    ...(taskStatus === 'completed' || taskStatus === 'failed' ? { completedAt: Date.now() } : {}),
  };
}

/**
 * 构建 DAG 可视化事件
 */
export function buildDAGStatusEvent(
  dagId: string,
  statusUpdate: TaskStatusEventData
): DAGVisualizationEvent {
  return {
    type: 'task:status',
    dagId,
    timestamp: Date.now(),
    data: statusUpdate,
  };
}
