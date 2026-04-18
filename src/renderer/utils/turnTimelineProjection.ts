import type { TraceNode, TraceProjection, TraceTurn } from '@shared/contract/trace';
import type { SwarmLaunchRequest } from '@shared/contract/swarm';
import type { ToolCall } from '@shared/contract/tool';
import type {
  TurnTimelineNode,
  TurnRoutingEvidence,
} from '@shared/contract/turnTimeline';
import {
  snapshotFromWorkbenchMetadata,
} from '@shared/contract/turnTimeline';
import type { WorkbenchCapabilities } from '../hooks/useWorkbenchCapabilities';
import type { RoutingEvidenceEvent } from '../stores/turnExecutionStore';
import type { SwarmTimelineEvent } from '../stores/swarmStore';
import { buildArtifactOwnershipItems } from './artifactOwnership';
import { buildWorkbenchCapabilityScope } from './workbenchScopeInspector';

interface ProjectionArgs {
  projection: TraceProjection;
  capabilities: WorkbenchCapabilities;
  launchRequests: SwarmLaunchRequest[];
  swarmEvents: SwarmTimelineEvent[];
  routingEvents: RoutingEvidenceEvent[];
}

interface TurnWindow {
  start: number;
  end: number;
}

function getTurnWindow(turns: TraceTurn[], index: number): TurnWindow {
  return {
    start: turns[index]?.startTime ?? 0,
    end: turns[index + 1]?.startTime ?? Number.POSITIVE_INFINITY,
  };
}

function isWithinWindow(timestamp: number | undefined, window: TurnWindow): boolean {
  if (timestamp === undefined) {
    return false;
  }

  return timestamp >= window.start && timestamp < window.end;
}

function buildTurnTimelineTraceNode(turnTimeline: TurnTimelineNode): TraceNode {
  return {
    id: turnTimeline.id,
    type: 'turn_timeline',
    content: '',
    timestamp: turnTimeline.timestamp,
    turnTimeline,
  };
}

function extractTurnToolCalls(turn: TraceTurn): ToolCall[] {
  return turn.nodes.flatMap((node) => {
    if (node.type !== 'tool_call' || !node.toolCall) {
      return [];
    }

    return [{
      id: node.toolCall.id,
      name: node.toolCall.name,
      arguments: node.toolCall.args,
    }];
  });
}

function buildDirectRoutingEvidence(
  turn: TraceTurn,
  window: TurnWindow,
  routingEvents: RoutingEvidenceEvent[],
): TurnRoutingEvidence | undefined {
  const userNode = turn.nodes.find((node) => node.type === 'user');
  const metadata = userNode?.metadata?.workbench;
  if (!metadata || metadata.routingMode !== 'direct') {
    return undefined;
  }

  const event = routingEvents
    .filter((entry) => entry.kind === 'direct')
    .find((entry) => entry.turnMessageId === userNode?.id)
    || routingEvents
      .filter((entry) => entry.kind === 'direct' && isWithinWindow(entry.timestamp, window))
      .slice(-1)[0];

  const deliveredTargetIds = event?.kind === 'direct'
    ? event.deliveredTargetIds
    : metadata.directRoutingDelivery?.deliveredTargetIds || metadata.targetAgentIds || [];
  const deliveredNames = event?.kind === 'direct'
    ? (event.targetAgentNames.length > 0 ? event.targetAgentNames : event.targetAgentIds)
    : metadata.directRoutingDelivery?.deliveredTargetNames?.length
      ? metadata.directRoutingDelivery.deliveredTargetNames
      : metadata.targetAgentNames?.length
        ? metadata.targetAgentNames
        : deliveredTargetIds;
  const missingTargetIds = event?.kind === 'direct'
    ? event.missingTargetIds
    : metadata.directRoutingDelivery?.missingTargetIds || [];
  const evidenceTimestamp = event?.kind === 'direct'
    ? event.timestamp
    : userNode?.timestamp;

  if (deliveredTargetIds.length === 0 && missingTargetIds.length === 0) {
    return undefined;
  }

  const steps: TurnRoutingEvidence['steps'] = [];
  if (deliveredTargetIds.length > 0) {
    steps.push({
      status: 'delivered',
      label: deliveredNames.length > 0
        ? `已发送给 ${deliveredNames.join('、')}`
        : 'Direct 路由已发送',
      tone: 'success',
      timestamp: evidenceTimestamp,
    });
  }

  if (missingTargetIds.length > 0) {
    steps.push({
      status: 'missing',
      label: `未命中 ${missingTargetIds.join('、')}`,
      tone: 'warning',
      timestamp: evidenceTimestamp,
    });
  }

  return {
    mode: 'direct',
    summary: missingTargetIds.length > 0
      ? `Direct 已发送，部分目标未命中`
      : deliveredNames.length > 0
        ? `Direct 已发送给 ${deliveredNames.join('、')}`
        : 'Direct 已发送',
    agentIds: deliveredTargetIds,
    agentNames: deliveredNames,
    steps,
  };
}

function buildAutoRoutingEvidence(
  turn: TraceTurn,
  window: TurnWindow,
  routingEvents: RoutingEvidenceEvent[],
): TurnRoutingEvidence | undefined {
  const metadata = turn.nodes.find((node) => node.type === 'user')?.metadata?.workbench;
  if (!metadata || metadata.routingMode !== 'auto') {
    return undefined;
  }

  const event = routingEvents
    .filter((entry) => entry.kind === 'auto' && isWithinWindow(entry.timestamp, window))
    .slice(-1)[0];

  if (!event || event.kind !== 'auto') {
    return undefined;
  }

  const fallbackToDefault = Boolean(event.fallbackToDefault);

  return {
    mode: 'auto',
    summary: fallbackToDefault
      ? 'Auto 未命中特定 agent，已回落默认执行'
      : `Auto 已路由到 ${event.agentName}`,
    agentIds: [event.agentId],
    agentNames: [event.agentName],
    reason: event.reason,
    score: event.score,
    steps: [{
      status: fallbackToDefault ? 'fallback' : 'resolved',
      label: fallbackToDefault
        ? `保持 ${event.agentName} 执行`
        : `路由到 ${event.agentName}`,
      detail: event.reason,
      tone: fallbackToDefault ? 'warning' : 'info',
      timestamp: event.timestamp,
    }],
  };
}

function buildParallelRoutingEvidence(
  turn: TraceTurn,
  window: TurnWindow,
  launchRequests: SwarmLaunchRequest[],
  swarmEvents: SwarmTimelineEvent[],
): TurnRoutingEvidence | undefined {
  const metadata = turn.nodes.find((node) => node.type === 'user')?.metadata?.workbench;
  if (!metadata || metadata.routingMode !== 'parallel') {
    return undefined;
  }

  const turnLaunchRequestIds = new Set(
    turn.nodes
      .filter((node) => node.type === 'swarm_launch_request')
      .map((node) => node.launchRequest?.id)
      .filter((id): id is string => Boolean(id)),
  );

  const relevantRequests = launchRequests.filter((request) =>
    turnLaunchRequestIds.has(request.id)
    || isWithinWindow(request.requestedAt, window)
    || isWithinWindow(request.resolvedAt, window)
  );
  const latestRequest = relevantRequests
    .sort((left, right) => left.requestedAt - right.requestedAt)
    .slice(-1)[0];

  const relevantEvents = swarmEvents.filter((event) =>
    isWithinWindow(event.timestamp, window)
    && (
      event.type === 'swarm:launch:requested'
      || event.type === 'swarm:launch:approved'
      || event.type === 'swarm:launch:rejected'
      || event.type === 'swarm:started'
    )
  );

  const steps: TurnRoutingEvidence['steps'] = [];

  if (latestRequest || relevantEvents.some((event) => event.type === 'swarm:launch:requested')) {
    steps.push({
      status: 'requested',
      label: latestRequest?.summary || '已生成并行编排请求',
      tone: 'warning',
      timestamp: latestRequest?.requestedAt || relevantEvents.find((event) => event.type === 'swarm:launch:requested')?.timestamp,
    });
  }

  if (latestRequest?.status === 'approved' || relevantEvents.some((event) => event.type === 'swarm:launch:approved')) {
    steps.push({
      status: 'approved',
      label: latestRequest?.feedback || '并行编排已确认',
      tone: 'success',
      timestamp: latestRequest?.resolvedAt || relevantEvents.find((event) => event.type === 'swarm:launch:approved')?.timestamp,
    });
  }

  if (latestRequest?.status === 'rejected' || relevantEvents.some((event) => event.type === 'swarm:launch:rejected')) {
    steps.push({
      status: 'rejected',
      label: latestRequest?.feedback || '并行编排已取消',
      tone: 'error',
      timestamp: latestRequest?.resolvedAt || relevantEvents.find((event) => event.type === 'swarm:launch:rejected')?.timestamp,
    });
  }

  const startedEvent = relevantEvents.find((event) => event.type === 'swarm:started');
  if (startedEvent) {
    steps.push({
      status: 'started',
      label: startedEvent.summary || '并行编排已启动',
      tone: 'success',
      timestamp: startedEvent.timestamp,
    });
  }

  if (steps.length === 0) {
    const hasExecutionNodes = turn.nodes.some((node) => node.type === 'assistant_text' || node.type === 'tool_call');
    if (!hasExecutionNodes) {
      return undefined;
    }

    return {
      mode: 'parallel',
      summary: 'Parallel 意图已记录，但当前轮次没有出现 launch 证据',
      steps: [{
        status: 'requested',
        label: '当前只记录了并行意图，尚未进入真实编排启动',
        tone: 'warning',
      }],
    };
  }

  const summary = steps.some((step) => step.status === 'started')
    ? '并行编排已启动'
    : steps.some((step) => step.status === 'rejected')
      ? '并行编排已取消'
      : steps.some((step) => step.status === 'approved')
        ? '并行编排已确认'
        : '等待并行编排确认';

  return {
    mode: 'parallel',
    summary,
    steps,
  };
}

function buildRoutingEvidence(
  turn: TraceTurn,
  window: TurnWindow,
  launchRequests: SwarmLaunchRequest[],
  swarmEvents: SwarmTimelineEvent[],
  routingEvents: RoutingEvidenceEvent[],
): TurnRoutingEvidence | undefined {
  return buildDirectRoutingEvidence(turn, window, routingEvents)
    || buildAutoRoutingEvidence(turn, window, routingEvents)
    || buildParallelRoutingEvidence(turn, window, launchRequests, swarmEvents);
}

function withoutWorkbenchMetadata(node: TraceNode): TraceNode {
  if (!node.metadata?.workbench) {
    return node;
  }

  return {
    ...node,
    metadata: {
      ...node.metadata,
      workbench: undefined,
    },
  };
}

function enrichTurn(
  turn: TraceTurn,
  index: number,
  turns: TraceTurn[],
  args: Omit<ProjectionArgs, 'projection'>,
): TraceTurn {
  const window = getTurnWindow(turns, index);
  const userIndex = turn.nodes.findIndex((node) => node.type === 'user');
  if (userIndex < 0) {
    return turn;
  }

  const userNode = turn.nodes[userIndex];
  const snapshot = snapshotFromWorkbenchMetadata(userNode.metadata?.workbench);
  const capabilityScope = buildWorkbenchCapabilityScope({
    snapshot,
    capabilities: args.capabilities,
    toolCalls: extractTurnToolCalls(turn),
    timestamp: turn.endTime || turn.startTime,
  });
  const routingEvidence = buildRoutingEvidence(
    turn,
    window,
    args.launchRequests,
    args.swarmEvents,
    args.routingEvents,
  );
  const artifactOwnership = buildArtifactOwnershipItems(turn, routingEvidence);

  if (!snapshot && !capabilityScope && !routingEvidence && artifactOwnership.length === 0) {
    return turn;
  }

  const nextNodes: TraceNode[] = [];

  turn.nodes.forEach((node, nodeIndex) => {
    nextNodes.push(nodeIndex === userIndex && snapshot ? withoutWorkbenchMetadata(node) : node);

    if (nodeIndex !== userIndex) {
      return;
    }

    if (snapshot) {
      nextNodes.push(buildTurnTimelineTraceNode({
        id: `${turn.turnId}-workbench-snapshot`,
        kind: 'workbench_snapshot',
        timestamp: node.timestamp,
        tone: 'info',
        snapshot,
      }));
    }

    if (capabilityScope) {
      nextNodes.push(buildTurnTimelineTraceNode({
        id: `${turn.turnId}-capability-scope`,
        kind: 'capability_scope',
        timestamp: node.timestamp,
        tone: capabilityScope.blocked.some((reason) => reason.severity === 'error')
          ? 'error'
          : capabilityScope.blocked.length > 0
            ? 'warning'
            : capabilityScope.invoked.length > 0
              ? 'success'
              : 'info',
        capabilityScope,
      }));
    }
  });

  if (routingEvidence) {
    nextNodes.push(buildTurnTimelineTraceNode({
      id: `${turn.turnId}-routing-evidence`,
      kind: 'routing_evidence',
      timestamp: turn.endTime || turn.startTime,
      tone: routingEvidence.steps.some((step) => step.tone === 'error')
        ? 'error'
        : routingEvidence.steps.some((step) => step.tone === 'warning')
          ? 'warning'
          : routingEvidence.steps.some((step) => step.tone === 'success')
            ? 'success'
            : 'info',
      routingEvidence,
    }));
  }

  if (artifactOwnership.length > 0) {
    nextNodes.push(buildTurnTimelineTraceNode({
      id: `${turn.turnId}-artifact-ownership`,
      kind: 'artifact_ownership',
      timestamp: turn.endTime || turn.startTime,
      tone: 'success',
      artifactOwnership,
    }));
  }

  return {
    ...turn,
    nodes: nextNodes,
  };
}

export function buildTurnExecutionClarityProjection(args: ProjectionArgs): TraceProjection {
  const sessionId = args.projection.sessionId;
  const launchRequests = sessionId
    ? args.launchRequests.filter((request) => request.sessionId === sessionId)
    : args.launchRequests;
  const swarmEvents = sessionId
    ? args.swarmEvents.filter((event) => event.sessionId === sessionId)
    : args.swarmEvents;

  return {
    ...args.projection,
    turns: args.projection.turns.map((turn, index, turns) => enrichTurn(turn, index, turns, {
      capabilities: args.capabilities,
      launchRequests,
      swarmEvents,
      routingEvents: args.routingEvents,
    })),
  };
}
