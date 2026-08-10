// ============================================================================
// Orchestrator DAG Sync - DAG visualization and explicit routing helpers
// ============================================================================

import type { AgentEvent } from '../../shared/contract';
import type { DAGVisualizationEvent } from '../../shared/contract/dagVisualization';
import type { RoutingResolution } from '../../shared/contract/agentRouting';
import { getPredefinedAgent } from './agentDefinition';
import { createLogger } from '../services/infra/logger';
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

export function syncDAGStatus(
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
