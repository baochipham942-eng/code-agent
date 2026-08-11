// ============================================================================
// Orchestrator DAG Sync - DAG visualization and explicit routing helpers
// ============================================================================

import type { AgentEvent } from '../../shared/contract';
import type { DAGVisualizationEvent } from '../../shared/contract/dagVisualization';
import type { RoutingResolution } from '../../shared/contract/agentRouting';
import { getPredefinedAgent } from './agentDefinition';
import { createLogger } from '../services/infra/logger';
import { TaskDAG } from '../scheduler/TaskDAG';
import { sendDAGInitEvent } from '../scheduler/dagEventBridge';
import {
  mapAgentEventToDAGStatus,
  mapAutoAgentStatusToDAGStatus,
  buildDAGStatusEvent,
} from './orchestrator/dagManager';

const logger = createLogger('AgentOrchestrator');

type BroadcastDAGEvent = (event: DAGVisualizationEvent) => void;

export function resolveExplicitAgentRouting(agentId: string): RoutingResolution | null {
  try {
    const agent = getPredefinedAgent(agentId);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.prompt,
        tools: agent.tools,
        readonly: agent.coordination?.readonly === true,
        enabled: true,
        tags: agent.tags,
      },
      score: 1000,
      reason: `Explicit agent selected: ${agent.id}`,
    };
  } catch (error) {
    logger.warn('Explicit agent selection failed, falling back to auto routing', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// 仅本文件内 initRunDag 的 dagAwareOnEvent 消费（orchestrator 抽走 F-4c 后不再跨文件 import）。
function syncDAGStatus(
  dagId: string,
  event: AgentEvent,
  broadcastDAGEvent?: BroadcastDAGEvent,
): void {
  const statusUpdate = mapAgentEventToDAGStatus(event);
  if (statusUpdate) {
    const vizEvent = buildDAGStatusEvent(dagId, statusUpdate);
    broadcastDAGEvent?.(vizEvent);
  }
}

/**
 * 建一轮 run 的可视化 DAG（单 main 节点）并发初始化事件，返回 dagId + dagAwareOnEvent——
 * 后者在原样透传 onEvent 之外，把每个事件映射进 DAG 状态广播。从 run 主线抽出（F-4c）。
 */
export function initRunDag(input: {
  sessionId: string | undefined;
  content: string;
  onEvent: (event: AgentEvent) => void;
  broadcastDAGEvent?: BroadcastDAGEvent;
}): { dagId: string; dagAwareOnEvent: (event: AgentEvent) => void } {
  const { content, onEvent, broadcastDAGEvent } = input;
  const dagId = `conv-${input.sessionId || Date.now()}`;
  const dag = new TaskDAG(dagId, content.substring(0, 50) + (content.length > 50 ? '...' : ''));
  dag.addAgentTask('main', {
    role: 'general-purpose',
    prompt: content,
  }, {
    name: '对话处理',
    description: content.substring(0, 100),
  });

  sendDAGInitEvent(dag);

  const dagAwareOnEvent = (event: AgentEvent) => {
    onEvent(event);
    syncDAGStatus(dagId, event, broadcastDAGEvent);
  };

  return { dagId, dagAwareOnEvent };
}

export function syncAutoAgentDAGStatus(
  dagId: string,
  agentId: string,
  status: string,
  broadcastDAGEvent?: BroadcastDAGEvent,
): void {
  const statusUpdate = mapAutoAgentStatusToDAGStatus(agentId, status);
  const vizEvent = buildDAGStatusEvent(dagId, statusUpdate);
  broadcastDAGEvent?.(vizEvent);
}
