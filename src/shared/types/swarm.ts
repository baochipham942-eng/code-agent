// ============================================================================
// Swarm Types - 共享类型定义
// ============================================================================

/**
 * Agent 执行状态（复制自 agentSwarm.ts 避免循环依赖）
 */
export type AgentStatus =
  | 'pending'     // 等待依赖
  | 'ready'       // 可执行
  | 'running'     // 执行中
  | 'completed'   // 已完成
  | 'failed'      // 失败
  | 'cancelled';  // 已取消

/**
 * Agent 实时状态（用于 UI 展示）
 */
export interface SwarmAgentState {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  startTime?: number;
  endTime?: number;
  iterations: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
  toolCalls?: number;
  lastReport?: string;
  error?: string;
}

/**
 * Swarm 执行状态（用于 UI 展示）
 */
export interface SwarmExecutionState {
  isRunning: boolean;
  startTime?: number;
  agents: SwarmAgentState[];
  statistics: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    parallelPeak: number;
    totalTokens: number;
    totalToolCalls: number;
  };
}

/**
 * Swarm 事件类型
 */
export type SwarmEventType =
  | 'swarm:started'
  | 'swarm:agent:added'
  | 'swarm:agent:updated'
  | 'swarm:agent:completed'
  | 'swarm:agent:failed'
  | 'swarm:completed'
  | 'swarm:cancelled';

/**
 * Swarm 事件载荷
 */
export interface SwarmEvent {
  type: SwarmEventType;
  timestamp: number;
  data: {
    agentId?: string;
    agentState?: SwarmAgentState;
    statistics?: SwarmExecutionState['statistics'];
    result?: {
      success: boolean;
      totalTime: number;
      aggregatedOutput?: string;
    };
  };
}
