// ============================================================================
// Swarm Store - Agent Swarm 实时状态管理
// ============================================================================

import { create } from 'zustand';
import type {
  SwarmAgentState,
  SwarmExecutionState,
  SwarmEvent,
  SwarmVerificationResult,
  SwarmAggregation,
  SwarmLaunchRequest,
  SwarmContextUpdateKind,
} from '@shared/contract/swarm';
import { createScopedSwarmMessageId } from '@shared/contract/swarm';
import type { CompletedAgentRun } from '@shared/contract/agentHistory';

export type SwarmExecutionPhase =
  | 'idle'
  | 'planning'
  | 'waiting_approval'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SwarmPlanReview {
  id: string;
  agentId: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  resolvedAt?: number;
  feedback?: string;
}

export interface SwarmConversationMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  messageType: string;
}

export interface SwarmTimelineEvent {
  id: string;
  sessionId?: string;
  runId?: string;
  type: SwarmEvent['type'];
  timestamp: number;
  title: string;
  summary: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
  agentId?: string;
  /** SharedContext 变更类型（讨论流分类用，P1-3） */
  contextKind?: SwarmContextUpdateKind;
  /** 决策点高亮（P1-3）：agent 关键方案选择 / 分歧，渲染时突出显示 */
  highlight?: boolean;
}

export interface SwarmRunSnapshot {
  key: string;
  sessionId: string;
  runId: string;
  treeId: string;
  parentNativeRunId?: string;
  /** A launch/started root event has authoritatively bound this run to treeId. */
  rootEventSeen: boolean;
  updatedAt?: number;
  lastAccessedAt: number;
  startTime?: number;
  statistics: SwarmExecutionState['statistics'];
  isRunning: boolean;
  executionPhase: SwarmExecutionPhase;
  verification?: SwarmVerificationResult;
  aggregation?: SwarmAggregation;
  launchRequests: SwarmLaunchRequest[];
  planReviews: SwarmPlanReview[];
  agents: SwarmAgentState[];
  messages: SwarmConversationMessage[];
  eventLog: SwarmTimelineEvent[];
  completedRuns: CompletedAgentRun[];
}

export interface SwarmStore extends SwarmExecutionState {
  verification?: SwarmVerificationResult;
  aggregation?: SwarmAggregation;
  executionPhase: SwarmExecutionPhase;
  launchRequests: SwarmLaunchRequest[];
  planReviews: SwarmPlanReview[];
  messages: SwarmConversationMessage[];
  eventLog: SwarmTimelineEvent[];
  completedRuns: CompletedAgentRun[];
  runSnapshots: Record<string, SwarmRunSnapshot>;
  activeSessionId?: string;
  activeRunId?: string;
  activeTreeId?: string;
  activeParentNativeRunId?: string;
  lastEventAt?: number;
  activateScope: (sessionId?: string | null, runId?: string) => void;
  handleEvent: (event: SwarmEvent) => void;
  reset: () => void;
}

type SwarmStateSnapshot = Omit<SwarmStore, 'activateScope' | 'handleEvent' | 'reset'>;

const MAX_MESSAGES = 40;
const MAX_EVENT_LOG = 80;

const MAX_COMPLETED_RUNS = 10;
export const MAX_RUN_SNAPSHOTS_PER_SESSION = 8;
export const MAX_RUN_SNAPSHOTS = 32;

const initialState: Pick<
  SwarmStore,
  | 'isRunning'
  | 'agents'
  | 'statistics'
  | 'verification'
  | 'aggregation'
  | 'executionPhase'
  | 'launchRequests'
  | 'planReviews'
  | 'messages'
  | 'eventLog'
  | 'completedRuns'
  | 'runSnapshots'
  | 'activeSessionId'
  | 'activeRunId'
  | 'activeTreeId'
  | 'activeParentNativeRunId'
  | 'startTime'
  | 'lastEventAt'
> = {
  isRunning: false,
  startTime: undefined,
  lastEventAt: undefined,
  agents: [],
  statistics: {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    parallelPeak: 0,
    totalTokens: 0,
    totalToolCalls: 0,
  },
  verification: undefined,
  aggregation: undefined,
  executionPhase: 'idle',
  launchRequests: [],
  planReviews: [],
  messages: [],
  eventLog: [],
  completedRuns: [],
  runSnapshots: {},
  activeSessionId: undefined,
  activeRunId: undefined,
  activeTreeId: undefined,
  activeParentNativeRunId: undefined,
};

function mergeAgentState(
  existing: SwarmAgentState | undefined,
  incoming: SwarmAgentState,
): SwarmAgentState {
  return {
    id: incoming.id,
    name: incoming.name || existing?.name || incoming.id,
    role: incoming.role || existing?.role || 'agent',
    status: incoming.status ?? existing?.status ?? 'pending',
    startTime: incoming.startTime ?? existing?.startTime,
    endTime: incoming.endTime ?? existing?.endTime,
    iterations: incoming.iterations ?? existing?.iterations ?? 0,
    tokenUsage: incoming.tokenUsage ?? existing?.tokenUsage,
    toolCalls: incoming.toolCalls ?? existing?.toolCalls,
    lastReport: incoming.lastReport ?? existing?.lastReport,
    error: incoming.error ?? existing?.error,
    cost: incoming.cost ?? existing?.cost,
    resultPreview: incoming.resultPreview ?? existing?.resultPreview,
    filesChanged: incoming.filesChanged ?? existing?.filesChanged,
    contextSnapshot: incoming.contextSnapshot ?? existing?.contextSnapshot,
  };
}

function updateAgentCollection(
  agents: SwarmAgentState[],
  incoming: SwarmAgentState,
): SwarmAgentState[] {
  const index = agents.findIndex((agent) => agent.id === incoming.id);
  if (index === -1) {
    return [...agents, mergeAgentState(undefined, incoming)];
  }

  const nextAgents = [...agents];
  nextAgents[index] = mergeAgentState(agents[index], incoming);
  return nextAgents;
}

function calculateStatistics(
  agents: SwarmAgentState[],
  previous: SwarmExecutionState['statistics'],
  incoming?: Partial<SwarmExecutionState['statistics']>,
): SwarmExecutionState['statistics'] {
  const running = agents.filter((agent) => agent.status === 'running').length;
  const pending = agents.filter((agent) => agent.status === 'pending' || agent.status === 'ready').length;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed' || agent.status === 'cancelled').length;
  const totalTokens = agents.reduce((sum, agent) => {
    const usage = agent.tokenUsage ?? { input: 0, output: 0 };
    return sum + usage.input + usage.output;
  }, 0);
  const totalToolCalls = agents.reduce((sum, agent) => sum + (agent.toolCalls ?? 0), 0);
  const total = Math.max(agents.length, incoming?.total ?? 0, previous.total);

  return {
    total,
    completed,
    failed,
    running,
    pending,
    parallelPeak: Math.max(previous.parallelPeak, running, incoming?.parallelPeak ?? 0),
    totalTokens: incoming?.totalTokens && incoming.totalTokens > 0 ? incoming.totalTokens : totalTokens,
    totalToolCalls: incoming?.totalToolCalls && incoming.totalToolCalls > 0
      ? incoming.totalToolCalls
      : totalToolCalls,
  };
}

function deriveExecutionPhase(state: Pick<SwarmStore, 'isRunning' | 'agents' | 'statistics' | 'planReviews' | 'launchRequests'>): SwarmExecutionPhase {
  if (state.launchRequests.some((request) => request.status === 'pending')) {
    return 'waiting_approval';
  }

  if (state.planReviews.some((review) => review.status === 'pending')) {
    return 'waiting_approval';
  }

  if (state.isRunning) {
    if (state.agents.some((agent) => agent.status === 'running')) {
      return 'executing';
    }
    if (state.agents.length > 0) {
      return 'planning';
    }
  }

  if (state.agents.some((agent) => agent.status === 'cancelled')) {
    return 'cancelled';
  }

  if (state.launchRequests.some((request) => request.status === 'rejected')) {
    return 'cancelled';
  }

  if (state.statistics.failed > 0 && state.statistics.completed === 0) {
    return 'failed';
  }

  if (state.statistics.completed > 0 || state.agents.length > 0) {
    return 'completed';
  }

  return 'idle';
}

function appendEventLog(
  eventLog: SwarmTimelineEvent[],
  entry: SwarmTimelineEvent | null,
): SwarmTimelineEvent[] {
  if (!entry) return eventLog;
  // 幂等：按 entry.id 去重，避免 EventBus 重放时 timeline 出现重复条目。
  // 见 ADR-010 #6。
  if (eventLog.some((existing) => existing.id === entry.id)) {
    return eventLog;
  }
  return [...eventLog, entry].slice(-MAX_EVENT_LOG);
}

function getCompletedRunStatus(
  eventType: SwarmEvent['type'],
  agentStatus: SwarmAgentState['status'],
): CompletedAgentRun['status'] {
  if (eventType === 'swarm:agent:completed') return 'completed';
  return agentStatus === 'cancelled' ? 'cancelled' : 'failed';
}

export function getSwarmRunSnapshotKey(sessionId: string, runId: string): string {
  return `${sessionId}::${runId}`;
}

export function getSwarmMessageKey(
  sessionId: string,
  runId: string,
  treeId: string,
  messageId: string,
): string {
  return createScopedSwarmMessageId({ sessionId, runId, treeId }, messageId);
}

function isSwarmRootEvent(event: SwarmEvent): boolean {
  return event.type === 'swarm:launch:requested' || event.type === 'swarm:started';
}

function createEmptyRunSnapshot(event: SwarmEvent): SwarmRunSnapshot {
  return {
    key: getSwarmRunSnapshotKey(event.sessionId, event.runId),
    sessionId: event.sessionId,
    runId: event.runId,
    treeId: event.treeId,
    parentNativeRunId: event.parentNativeRunId,
    rootEventSeen: isSwarmRootEvent(event),
    updatedAt: event.timestamp,
    lastAccessedAt: event.timestamp,
    startTime: undefined,
    statistics: { ...initialState.statistics },
    isRunning: false,
    executionPhase: 'idle',
    verification: undefined,
    aggregation: undefined,
    launchRequests: [],
    planReviews: [],
    agents: [],
    messages: [],
    eventLog: [],
    completedRuns: [],
  };
}

function findLatestRunSnapshot(
  snapshots: Record<string, SwarmRunSnapshot>,
  sessionId: string,
): SwarmRunSnapshot | undefined {
  return Object.values(snapshots)
    .filter((snapshot) => snapshot.sessionId === sessionId)
    .sort((left, right) => {
      if (left.isRunning !== right.isRunning) return left.isRunning ? -1 : 1;
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    })[0];
}

function pruneRunSnapshots(
  snapshots: Record<string, SwarmRunSnapshot>,
  activeSessionId?: string,
  activeRunId?: string,
  incomingKey?: string,
): Record<string, SwarmRunSnapshot> {
  const protectedKeys = new Set<string>();
  if (activeSessionId && activeRunId) {
    protectedKeys.add(getSwarmRunSnapshotKey(activeSessionId, activeRunId));
  }
  if (incomingKey) protectedKeys.add(incomingKey);
  for (const snapshot of Object.values(snapshots)) {
    if (snapshot.isRunning) protectedKeys.add(snapshot.key);
  }

  const next = { ...snapshots };
  const oldestFirst = (left: SwarmRunSnapshot, right: SwarmRunSnapshot) => {
    const leftRecency = Math.max(left.updatedAt ?? 0, left.lastAccessedAt);
    const rightRecency = Math.max(right.updatedAt ?? 0, right.lastAccessedAt);
    return leftRecency - rightRecency || left.key.localeCompare(right.key);
  };

  const sessions = new Set(Object.values(next).map((snapshot) => snapshot.sessionId));
  for (const sessionId of sessions) {
    let sessionSnapshots = Object.values(next)
      .filter((snapshot) => snapshot.sessionId === sessionId)
      .sort(oldestFirst);
    while (sessionSnapshots.length > MAX_RUN_SNAPSHOTS_PER_SESSION) {
      const eviction = sessionSnapshots.find((snapshot) => !protectedKeys.has(snapshot.key));
      if (!eviction) break;
      delete next[eviction.key];
      sessionSnapshots = sessionSnapshots.filter((snapshot) => snapshot.key !== eviction.key);
    }
  }

  let allSnapshots = Object.values(next).sort(oldestFirst);
  while (allSnapshots.length > MAX_RUN_SNAPSHOTS) {
    const eviction = allSnapshots.find((snapshot) => !protectedKeys.has(snapshot.key));
    if (!eviction) break;
    delete next[eviction.key];
    allSnapshots = allSnapshots.filter((snapshot) => snapshot.key !== eviction.key);
  }
  return next;
}

function projectRunSnapshot(
  snapshot: SwarmRunSnapshot,
  runSnapshots: Record<string, SwarmRunSnapshot>,
): SwarmStateSnapshot {
  return {
    ...initialState,
    runSnapshots,
    activeSessionId: snapshot.sessionId,
    activeRunId: snapshot.runId,
    activeTreeId: snapshot.treeId,
    activeParentNativeRunId: snapshot.parentNativeRunId,
    startTime: snapshot.startTime,
    lastEventAt: snapshot.updatedAt,
    isRunning: snapshot.isRunning,
    statistics: snapshot.statistics,
    verification: snapshot.verification,
    aggregation: snapshot.aggregation,
    executionPhase: snapshot.executionPhase,
    launchRequests: snapshot.launchRequests,
    planReviews: snapshot.planReviews,
    agents: snapshot.agents,
    messages: snapshot.messages,
    eventLog: snapshot.eventLog,
    completedRuns: snapshot.completedRuns,
  };
}

function reduceRunSnapshot(
  current: SwarmRunSnapshot,
  event: SwarmEvent,
): { snapshot: SwarmRunSnapshot; completedRun: CompletedAgentRun | null } {
  let snapshot: SwarmRunSnapshot = {
    ...current,
    treeId: event.treeId,
    parentNativeRunId: event.parentNativeRunId ?? current.parentNativeRunId,
    updatedAt: Math.max(current.updatedAt ?? 0, event.timestamp),
    lastAccessedAt: Math.max(current.lastAccessedAt, event.timestamp),
  };
  let completedRun: CompletedAgentRun | null = null;

  switch (event.type) {
    case 'swarm:launch:requested':
    case 'swarm:launch:approved':
    case 'swarm:launch:rejected':
      snapshot = {
        ...snapshot,
        launchRequests: upsertLaunchRequest(snapshot.launchRequests, event),
      };
      break;

    case 'swarm:started':
      snapshot = {
        ...snapshot,
        isRunning: true,
        startTime: snapshot.startTime ?? event.timestamp,
        statistics: calculateStatistics(
          snapshot.agents,
          snapshot.statistics,
          event.data.statistics || undefined,
        ),
      };
      break;

    case 'swarm:agent:added':
    case 'swarm:agent:updated':
    case 'swarm:agent:completed':
    case 'swarm:agent:failed': {
      if (!event.data.agentState) break;
      const agents = updateAgentCollection(snapshot.agents, event.data.agentState);
      let completedRuns = snapshot.completedRuns;

      if (event.type === 'swarm:agent:completed' || event.type === 'swarm:agent:failed') {
        const mergedAgent = agents.find((agent) => agent.id === event.data.agentState!.id);
        if (mergedAgent && !completedRuns.some((run) => run.id === mergedAgent.id)) {
          completedRun = buildCompletedRun(
            mergedAgent,
            getCompletedRunStatus(event.type, mergedAgent.status),
            event.sessionId,
          );
          completedRuns = [...completedRuns, completedRun].slice(-MAX_COMPLETED_RUNS);
        }
      }

      snapshot = {
        ...snapshot,
        agents,
        completedRuns,
        statistics: calculateStatistics(
          agents,
          snapshot.statistics,
          event.data.statistics || undefined,
        ),
      };
      break;
    }

    case 'swarm:agent:plan_review':
    case 'swarm:agent:plan_approved':
    case 'swarm:agent:plan_rejected':
      snapshot = {
        ...snapshot,
        planReviews: upsertPlanReview(snapshot.planReviews, event),
      };
      break;

    case 'swarm:agent:message':
    case 'swarm:user:message':
      snapshot = {
        ...snapshot,
        messages: appendMessage(snapshot.messages, event),
      };
      break;

    case 'swarm:completed':
    case 'swarm:cancelled':
      snapshot = {
        ...snapshot,
        isRunning: false,
        verification: event.data.result?.verification || snapshot.verification,
        aggregation: event.data.result?.aggregation || snapshot.aggregation,
        statistics: calculateStatistics(
          snapshot.agents,
          snapshot.statistics,
          event.data.statistics || undefined,
        ),
      };
      break;

    default:
      break;
  }

  const eventLog = appendEventLog(snapshot.eventLog, buildTimelineEntry(event, snapshot.agents));
  snapshot = {
    ...snapshot,
    eventLog,
    executionPhase: deriveExecutionPhase(snapshot),
  };

  return { snapshot, completedRun };
}

function buildTimelineEntry(event: SwarmEvent, agents: SwarmAgentState[]): SwarmTimelineEvent | null {
  // agent 相关事件大部分通过 agentState 携带 id，而不是 event.data.agentId；
  // fallback 到 agentState.id 保证 timeline entry id 带上 agent 后缀，避免
  // appendEventLog 按 id 去重时把 swarm:agent:added-undefined 和
  // swarm:agent:updated-undefined 当成同一条记录。见 ADR-010 #6。
  const agentId = event.data.agentId ?? event.data.agentState?.id;
  const agentName = agentId
    ? agents.find((agent) => agent.id === agentId)?.name ?? agentId
    : undefined;
  const sessionId = event.sessionId;
  const runId = event.runId;

  switch (event.type) {
    case 'swarm:launch:requested':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: '等待启动确认',
        summary: event.data.launchRequest?.summary || '待确认并行编排',
        tone: 'warning',
      };
    case 'swarm:launch:approved':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: '启动已确认',
        summary: event.data.launchRequest?.feedback || '准备开始执行',
        tone: 'success',
      };
    case 'swarm:launch:rejected':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: '启动已取消',
        summary: event.data.launchRequest?.feedback || '并行编排被取消',
        tone: 'error',
      };
    case 'swarm:started':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: '编排开始',
        summary: `启动 ${event.data.statistics?.total ?? 0} 个并行 agent`,
        tone: 'neutral',
      };
    case 'swarm:agent:added':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} 已加入`,
        summary: event.data.agentState?.role || '等待分配任务',
        tone: 'neutral',
        agentId,
      };
    case 'swarm:agent:updated':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} ${event.data.agentState?.status ?? 'updated'}`,
        summary: event.data.agentState?.lastReport || '状态已刷新',
        tone: event.data.agentState?.status === 'running' ? 'warning' : 'neutral',
        agentId,
      };
    case 'swarm:agent:completed':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} 已完成`,
        summary: event.data.agentState?.lastReport || '任务交付完成',
        tone: 'success',
        agentId,
      };
    case 'swarm:agent:failed':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} 失败`,
        summary: event.data.agentState?.error || '执行异常',
        tone: 'error',
        agentId,
      };
    case 'swarm:agent:plan_review':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} 请求审批`,
        summary: event.data.plan?.content || '等待用户确认计划',
        tone: 'warning',
        agentId,
      };
    case 'swarm:agent:plan_approved':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} 审批通过`,
        summary: event.data.plan?.feedback || '继续执行',
        tone: 'success',
        agentId,
      };
    case 'swarm:agent:plan_rejected':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: `${agentName ?? 'Agent'} 审批驳回`,
        summary: event.data.plan?.feedback || '等待调整方案',
        tone: 'error',
        agentId,
      };
    case 'swarm:agent:message':
    case 'swarm:user:message':
      return {
        id: `evt-${event.timestamp}-${event.type}-${event.data.message?.id ?? agentId ?? 'msg'}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: event.type === 'swarm:user:message' ? '用户介入' : 'Agent 协作消息',
        summary: event.data.message?.content || '',
        tone: 'neutral',
        agentId,
      };
    case 'swarm:completed':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: '编排完成',
        summary: event.data.result?.aggregation?.summary || '并行任务已汇总',
        tone: 'success',
      };
    case 'swarm:cancelled':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: '编排已取消',
        summary: '任务被中止',
        tone: 'warning',
      };
    case 'swarm:context:update': {
      // SharedContext 协作过程 → 讨论流（P1-3）
      const update = event.data.contextUpdate;
      const who = update?.role || agentName || 'Agent';
      const kind: SwarmContextUpdateKind = update?.kind ?? 'status';
      const titleByKind: Record<SwarmContextUpdateKind, string> = {
        finding: `${who} 发现`,
        decision: `${who} 决策`,
        status: `${who} 进展`,
        result: `${who} 交付`,
      };
      const toneByKind: Record<SwarmContextUpdateKind, SwarmTimelineEvent['tone']> = {
        finding: 'neutral',
        decision: 'warning',
        status: 'neutral',
        result: 'success',
      };
      return {
        id: `evt-${event.timestamp}-${event.type}-${kind}-${update?.key ?? agentId ?? 'ctx'}`,
        sessionId,
        runId,
        type: event.type,
        timestamp: event.timestamp,
        title: titleByKind[kind],
        summary: update?.content || '',
        tone: toneByKind[kind],
        agentId: update?.agentId ?? agentId,
        contextKind: kind,
        highlight: kind === 'decision',
      };
    }
    default:
      return null;
  }
}

function upsertLaunchRequest(
  launchRequests: SwarmLaunchRequest[],
  event: SwarmEvent,
): SwarmLaunchRequest[] {
  const incoming = event.data.launchRequest;
  if (!incoming) return launchRequests;

  if (event.type === 'swarm:launch:requested') {
    return [{ ...incoming, tasks: incoming.tasks.map((task) => ({ ...task })) }];
  }

  if (event.type === 'swarm:launch:approved' || event.type === 'swarm:launch:rejected') {
    const nextRequests = [...launchRequests];
    const index = nextRequests.findIndex((request) => request.id === incoming.id);
    const nextRequest = {
      ...incoming,
      tasks: incoming.tasks.map((task) => ({ ...task })),
    };

    if (index === -1) {
      nextRequests.push(nextRequest);
    } else {
      nextRequests[index] = nextRequest;
    }

    return nextRequests;
  }

  return launchRequests;
}

function upsertPlanReview(planReviews: SwarmPlanReview[], event: SwarmEvent): SwarmPlanReview[] {
  if (!event.data.plan || !event.data.agentId) return planReviews;

  if (event.type === 'swarm:agent:plan_review') {
    const planId = event.data.plan.id || `plan-${event.data.agentId}-${event.timestamp}`;
    // 幂等：已存在同 id 的 review（无论 pending 还是已 resolved）不再 push。
    // 这同时覆盖两种场景：(a) plan_review 重放；(b) plan_approved 先到落下 fallback
    // 记录后 plan_review 再到，不再新建 pending。见 ADR-010 #6。
    if (planReviews.some((review) => review.id === planId)) {
      return planReviews;
    }
    return [
      ...planReviews,
      {
        id: planId,
        agentId: event.data.agentId,
        content: event.data.plan.content,
        status: 'pending',
        requestedAt: event.timestamp,
      },
    ];
  }

  if (event.type === 'swarm:agent:plan_approved' || event.type === 'swarm:agent:plan_rejected') {
    const status = event.type === 'swarm:agent:plan_approved' ? 'approved' : 'rejected';
    let resolved = false;
    const nextReviews = [...planReviews];
    const incomingPlanId = event.data.plan.id;

    for (let index = nextReviews.length - 1; index >= 0; index -= 1) {
      const review = nextReviews[index];
      const isTargetReview = incomingPlanId
        ? review.id === incomingPlanId
        : review.agentId === event.data.agentId && review.status === 'pending';

      if (isTargetReview && review.status === 'pending') {
        nextReviews[index] = {
          ...review,
          status,
          resolvedAt: event.timestamp,
          feedback: event.data.plan.feedback,
        };
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      const fallbackId = event.data.plan.id || `plan-${event.data.agentId}-${event.timestamp}`;
      // 幂等：终结事件的 fallback push 也要去重。重复投递 plan_approved 时
      // 第一次已经落下 approved 记录，第二次不应再 push 第二条。见 ADR-010 #6。
      if (nextReviews.some((review) => review.id === fallbackId)) {
        return nextReviews;
      }
      nextReviews.push({
        id: fallbackId,
        agentId: event.data.agentId,
        content: event.data.plan.content,
        status,
        requestedAt: event.timestamp,
        resolvedAt: event.timestamp,
        feedback: event.data.plan.feedback,
      });
    }

    return nextReviews;
  }

  return planReviews;
}

function appendMessage(
  messages: SwarmConversationMessage[],
  event: SwarmEvent,
): SwarmConversationMessage[] {
  if (
    (event.type !== 'swarm:agent:message' && event.type !== 'swarm:user:message')
    || !event.data.message
  ) {
    return messages;
  }

  const id = getSwarmMessageKey(
    event.sessionId,
    event.runId,
    event.treeId,
    event.data.message.id,
  );
  // 幂等：EventBus 重放同一条消息时按 id 去重，避免 UI 出现两条重复条目。
  // 见 ADR-010 #6。
  if (messages.some((m) => m.id === id)) {
    return messages;
  }

  return [
    ...messages,
    {
      id,
      from: event.data.message.from,
      to: event.data.message.to,
      content: event.data.message.content,
      timestamp: event.timestamp,
      messageType: event.data.message.messageType || 'coordination',
    },
  ].slice(-MAX_MESSAGES);
}

/**
 * 从 merged agent state 构建 CompletedAgentRun 记录
 */
function buildCompletedRun(
  agent: SwarmAgentState,
  status: 'completed' | 'failed' | 'cancelled',
  sessionId?: string,
): CompletedAgentRun {
  const endTime = agent.endTime ?? Date.now();
  const startTime = agent.startTime ?? endTime;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    tokenUsage: agent.tokenUsage ?? { input: 0, output: 0 },
    toolCalls: agent.toolCalls ?? 0,
    resultPreview: (agent.resultPreview || agent.lastReport || agent.error || '')
      .slice(0, 200) || undefined,
    sessionId: sessionId ?? '',
  };
}

/**
 * ADR-010 #5：renderer 不再触发 agent-history.json 写入。
 * 持久化逻辑已迁到 main 进程的 SwarmTraceWriter，订阅 EventBus 'swarm'
 * domain 直接落 SQLite，包含 agent rollup + 完整 timeline，比旧 JSON
 * 文件覆盖更广。`completedRuns` 仍保留供 UI 实时展示。
 *
 * 旧 IPC 通道 SWARM_PERSIST_AGENT_RUN 与 agent-history.json 的读路径
 * 仍在 main 侧保留以兼容历史数据，但 renderer 不再调用写入端。
 */
function persistRunViaIPC(_run: CompletedAgentRun): void {
  // intentionally no-op — see ADR-010 #5
}

export const useSwarmStore = create<SwarmStore>((set) => ({
  ...initialState,

  activateScope: (sessionId?: string | null, runId?: string) => {
    set((state) => {
      if (!sessionId) {
        return {
          ...initialState,
          runSnapshots: state.runSnapshots,
        };
      }

      const snapshot = runId
        ? state.runSnapshots[getSwarmRunSnapshotKey(sessionId, runId)]
        : findLatestRunSnapshot(state.runSnapshots, sessionId);

      if (snapshot) {
        const touched = {
          ...snapshot,
          lastAccessedAt: Math.max(snapshot.lastAccessedAt, Date.now()),
        };
        const runSnapshots = pruneRunSnapshots(
          { ...state.runSnapshots, [touched.key]: touched },
          touched.sessionId,
          touched.runId,
          touched.key,
        );
        return projectRunSnapshot(touched, runSnapshots);
      }

      return {
        ...initialState,
        runSnapshots: state.runSnapshots,
        activeSessionId: sessionId,
        activeRunId: runId,
      };
    });
  },

  handleEvent: (event: SwarmEvent) => {
    // 所有事件先归档到自己的 run snapshot。只有命中 active scope 的快照才投影
    // 到顶层视图，后台 Team 的 root/late event 不再改写用户当前看到的 Team。
    let newlyAddedRun: CompletedAgentRun | null = null;
    set((state) => {
      const key = getSwarmRunSnapshotKey(event.sessionId, event.runId);
      const existing = state.runSnapshots[key];
      if (existing && existing.treeId !== event.treeId) {
        // Events may race the authoritative launch/started root. A provisional
        // snapshot can be replaced by that root, but once bound, every foreign
        // tree event fails closed for the lifetime of this run snapshot.
        if (!isSwarmRootEvent(event) || existing.rootEventSeen) return state;
      }
      const current = existing?.treeId === event.treeId
        ? existing
        : createEmptyRunSnapshot(event);
      const reduced = reduceRunSnapshot(current, event);
      if (isSwarmRootEvent(event) && !reduced.snapshot.rootEventSeen) {
        reduced.snapshot = { ...reduced.snapshot, rootEventSeen: true };
      }
      newlyAddedRun = reduced.completedRun;
      const runSnapshots = pruneRunSnapshots({
        ...state.runSnapshots,
        [key]: reduced.snapshot,
      }, state.activeSessionId, state.activeRunId, key);

      const matchesActiveScope =
        state.activeSessionId === event.sessionId
        && state.activeRunId === event.runId;
      const establishesActiveRun =
        state.activeSessionId === event.sessionId
        && !state.activeRunId;
      if (matchesActiveScope || establishesActiveRun) {
        return projectRunSnapshot(reduced.snapshot, runSnapshots);
      }

      return {
        ...state,
        runSnapshots,
      };
    });

    // Side effect: 只在本次事件真正新增了 completedRun 时才持久化，避免重放重复 IPC。
    if (newlyAddedRun) {
      persistRunViaIPC(newlyAddedRun);
    }
  },

  reset: () => set(initialState),
}));
