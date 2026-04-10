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
} from '@shared/types/swarm';

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
  type: SwarmEvent['type'];
  timestamp: number;
  title: string;
  summary: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
  agentId?: string;
}

interface SwarmStore extends SwarmExecutionState {
  verification?: SwarmVerificationResult;
  aggregation?: SwarmAggregation;
  executionPhase: SwarmExecutionPhase;
  launchRequests: SwarmLaunchRequest[];
  planReviews: SwarmPlanReview[];
  messages: SwarmConversationMessage[];
  eventLog: SwarmTimelineEvent[];
  lastEventAt?: number;
  handleEvent: (event: SwarmEvent) => void;
  reset: () => void;
}

type SwarmStateSnapshot = Omit<SwarmStore, 'handleEvent' | 'reset'>;

const MAX_MESSAGES = 40;
const MAX_EVENT_LOG = 80;

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
  return [...eventLog, entry].slice(-MAX_EVENT_LOG);
}

function buildTimelineEntry(event: SwarmEvent, agents: SwarmAgentState[]): SwarmTimelineEvent | null {
  const agentId = event.data.agentId;
  const agentName = agentId
    ? agents.find((agent) => agent.id === agentId)?.name ?? agentId
    : undefined;

  switch (event.type) {
    case 'swarm:launch:requested':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        type: event.type,
        timestamp: event.timestamp,
        title: '等待启动确认',
        summary: event.data.launchRequest?.summary || '待确认并行编排',
        tone: 'warning',
      };
    case 'swarm:launch:approved':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        type: event.type,
        timestamp: event.timestamp,
        title: '启动已确认',
        summary: event.data.launchRequest?.feedback || '准备开始执行',
        tone: 'success',
      };
    case 'swarm:launch:rejected':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        type: event.type,
        timestamp: event.timestamp,
        title: '启动已取消',
        summary: event.data.launchRequest?.feedback || '并行编排被取消',
        tone: 'error',
      };
    case 'swarm:started':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        type: event.type,
        timestamp: event.timestamp,
        title: '编排开始',
        summary: `启动 ${event.data.statistics?.total ?? 0} 个并行 agent`,
        tone: 'neutral',
      };
    case 'swarm:agent:added':
      return {
        id: `evt-${event.timestamp}-${event.type}-${agentId}`,
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
        id: `evt-${event.timestamp}-${event.type}-${agentId ?? 'msg'}`,
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
        type: event.type,
        timestamp: event.timestamp,
        title: '编排完成',
        summary: event.data.result?.aggregation?.summary || '并行任务已汇总',
        tone: 'success',
      };
    case 'swarm:cancelled':
      return {
        id: `evt-${event.timestamp}-${event.type}`,
        type: event.type,
        timestamp: event.timestamp,
        title: '编排已取消',
        summary: '任务被中止',
        tone: 'warning',
      };
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
    return [
      ...planReviews,
      {
        id: event.data.plan.id || `plan-${event.data.agentId}-${event.timestamp}`,
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
      nextReviews.push({
        id: event.data.plan.id || `plan-${event.data.agentId}-${event.timestamp}`,
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

  return [
    ...messages,
    {
      id: `msg-${event.timestamp}-${event.data.message.from}-${event.data.message.to}`,
      from: event.data.message.from,
      to: event.data.message.to,
      content: event.data.message.content,
      timestamp: event.timestamp,
      messageType: event.data.message.messageType || 'coordination',
    },
  ].slice(-MAX_MESSAGES);
}

export const useSwarmStore = create<SwarmStore>((set) => ({
  ...initialState,

  handleEvent: (event: SwarmEvent) => {
    set((state) => {
      let nextState: SwarmStateSnapshot = {
        ...state,
        lastEventAt: event.timestamp,
      };

      switch (event.type) {
        case 'swarm:launch:requested':
          nextState = {
            ...initialState,
            lastEventAt: event.timestamp,
            launchRequests: upsertLaunchRequest([], event),
          };
          break;

        case 'swarm:launch:approved':
        case 'swarm:launch:rejected':
          nextState = {
            ...state,
            lastEventAt: event.timestamp,
            launchRequests: upsertLaunchRequest(state.launchRequests, event),
          };
          break;

        case 'swarm:started':
          nextState = {
            ...state,
            ...initialState,
            isRunning: true,
            startTime: event.timestamp,
            lastEventAt: event.timestamp,
            statistics: {
              ...initialState.statistics,
              ...(event.data.statistics || {}),
            },
          };
          break;

        case 'swarm:agent:added':
        case 'swarm:agent:updated':
        case 'swarm:agent:completed':
        case 'swarm:agent:failed': {
          if (event.data.agentState) {
            const agents = updateAgentCollection(state.agents, event.data.agentState);
            nextState = {
              ...state,
              agents,
              lastEventAt: event.timestamp,
              statistics: calculateStatistics(agents, state.statistics),
            };
          }
          break;
        }

        case 'swarm:agent:plan_review':
        case 'swarm:agent:plan_approved':
        case 'swarm:agent:plan_rejected':
          nextState = {
            ...state,
            lastEventAt: event.timestamp,
            planReviews: upsertPlanReview(state.planReviews, event),
          };
          break;

        case 'swarm:agent:message':
        case 'swarm:user:message':
          nextState = {
            ...state,
            lastEventAt: event.timestamp,
            messages: appendMessage(state.messages, event),
          };
          break;

        case 'swarm:completed':
        case 'swarm:cancelled':
          nextState = {
            ...state,
            isRunning: false,
            lastEventAt: event.timestamp,
            verification: event.data.result?.verification || state.verification,
            aggregation: event.data.result?.aggregation || state.aggregation,
            statistics: calculateStatistics(
              state.agents,
              state.statistics,
              event.data.statistics || undefined,
            ),
          };
          break;
      }

      const executionPhase = deriveExecutionPhase(nextState);
      const eventLog = appendEventLog(
        nextState.eventLog,
        buildTimelineEntry(event, nextState.agents),
      );

      return {
        ...nextState,
        executionPhase,
        eventLog,
      };
    });
  },

  reset: () => set(initialState),
}));
