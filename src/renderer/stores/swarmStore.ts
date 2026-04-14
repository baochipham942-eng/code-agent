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
} from '@shared/contract/swarm';
import type { CompletedAgentRun } from '@shared/contract/agentHistory';
import { IPC_CHANNELS } from '@shared/ipc/legacy-channels';
import { invoke } from '../services/ipcService';

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

export interface SwarmStore extends SwarmExecutionState {
  verification?: SwarmVerificationResult;
  aggregation?: SwarmAggregation;
  executionPhase: SwarmExecutionPhase;
  launchRequests: SwarmLaunchRequest[];
  planReviews: SwarmPlanReview[];
  messages: SwarmConversationMessage[];
  eventLog: SwarmTimelineEvent[];
  completedRuns: CompletedAgentRun[];
  lastEventAt?: number;
  handleEvent: (event: SwarmEvent) => void;
  reset: () => void;
}

type SwarmStateSnapshot = Omit<SwarmStore, 'handleEvent' | 'reset'>;

const MAX_MESSAGES = 40;
const MAX_EVENT_LOG = 80;

const MAX_COMPLETED_RUNS = 10;

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

function buildTimelineEntry(event: SwarmEvent, agents: SwarmAgentState[]): SwarmTimelineEvent | null {
  // agent 相关事件大部分通过 agentState 携带 id，而不是 event.data.agentId；
  // fallback 到 agentState.id 保证 timeline entry id 带上 agent 后缀，避免
  // appendEventLog 按 id 去重时把 swarm:agent:added-undefined 和
  // swarm:agent:updated-undefined 当成同一条记录。见 ADR-010 #6。
  const agentId = event.data.agentId ?? event.data.agentState?.id;
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

  const id = `msg-${event.timestamp}-${event.data.message.from}-${event.data.message.to}`;
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
    sessionId: '',  // 由调用方填充
  };
}

/**
 * 将 CompletedAgentRun 通过 IPC 持久化到 main 进程（fire-and-forget）
 */
function persistRunViaIPC(run: CompletedAgentRun): void {
  try {
    void invoke(IPC_CHANNELS.SWARM_PERSIST_AGENT_RUN, {
      sessionId: run.sessionId,
      run,
    });
  } catch {
    // 静默失败 — 持久化为增强功能，不影响核心流程
  }
}

export const useSwarmStore = create<SwarmStore>((set) => ({
  ...initialState,

  handleEvent: (event: SwarmEvent) => {
    // 跟踪本次事件是否新增了 completedRun；仅当新增时才触发 IPC 持久化，
    // 避免重放同一个 agent:completed 时调用两次 persist。见 ADR-010 #6。
    let newlyAddedRun: CompletedAgentRun | null = null;
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

        case 'swarm:started': {
          // 乱序保护：如果 agent/plan/completedRun 事件因为 EventBus 调度抖动先于
          // swarm:started 到达，reducer 不能用 initialState 把它们抹掉。仅当当前
          // state 没有任何活动数据时才做全量 reset（新 run 的首次 started）。
          // 见 ADR-010 item #6。
          const hasActivity =
            state.agents.length > 0
            || state.completedRuns.length > 0
            || state.planReviews.length > 0
            || state.messages.length > 0;
          if (hasActivity) {
            nextState = {
              ...state,
              isRunning: true,
              startTime: state.startTime ?? event.timestamp,
              lastEventAt: event.timestamp,
              statistics: calculateStatistics(
                state.agents,
                state.statistics,
                event.data.statistics || undefined,
              ),
            };
          } else {
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
          }
          break;
        }

        case 'swarm:agent:added':
        case 'swarm:agent:updated':
        case 'swarm:agent:completed':
        case 'swarm:agent:failed': {
          if (event.data.agentState) {
            const agents = updateAgentCollection(state.agents, event.data.agentState);
            let { completedRuns } = state;

            // 在 completed/failed 事件时构建 run 记录并追加到本地列表。
            // 幂等：如果同 id 的 run 已存在，不再重复 push，也不标记需要 persist。
            // 见 ADR-010 #6。
            if (event.type === 'swarm:agent:completed' || event.type === 'swarm:agent:failed') {
              const mergedAgent = agents.find((a) => a.id === event.data.agentState!.id);
              if (mergedAgent && !completedRuns.some((r) => r.id === mergedAgent.id)) {
                const runStatus = event.type === 'swarm:agent:completed' ? 'completed' : 'failed';
                const run = buildCompletedRun(mergedAgent, runStatus);
                completedRuns = [...completedRuns, run].slice(-MAX_COMPLETED_RUNS);
                newlyAddedRun = run;
              }
            }

            nextState = {
              ...state,
              agents,
              completedRuns,
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

    // Side effect: 只在本次事件真正新增了 completedRun 时才持久化，避免重放重复 IPC。
    if (newlyAddedRun) {
      persistRunViaIPC(newlyAddedRun);
    }
  },

  reset: () => set(initialState),
}));
