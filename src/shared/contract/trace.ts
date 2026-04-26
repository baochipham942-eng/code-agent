// ============================================================================
// Trace Types - Turn-based trace view projection
// ============================================================================

export type TraceNodeType =
  | 'user'
  | 'assistant_text'
  | 'tool_call'
  | 'system'
  | 'swarm_launch_request'
  | 'turn_timeline';

export interface TraceNode {
  id: string;
  type: TraceNodeType;
  content: string;
  timestamp: number;
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: string;
    success?: boolean;
    duration?: number;
    outputPath?: string;
    metadata?: Record<string, unknown>;
    _streaming?: boolean;
    // ============================================================================
    // 语义元数据（产品视角升级 — P0 内核）
    // 由 main 进程在投影 trace 时从 ToolCall 复制过来。UI 优先消费。
    // ============================================================================
    shortDescription?: string;
    targetContext?: import('./tool').ToolCallTargetContext;
    expectedOutcome?: string;
  };
  reasoning?: string;
  thinking?: string;
  subtype?: 'compaction' | 'error' | 'skill_status';
  attachments?: import('./message').MessageAttachment[];
  artifacts?: import('./message').Artifact[];
  metadata?: import('./message').MessageMetadata;
  launchRequest?: import('./swarm').SwarmLaunchRequest;
  turnTimeline?: import('./turnTimeline').TurnTimelineNode;
}

export interface TraceTurn {
  turnNumber: number;
  turnId: string;
  nodes: TraceNode[];
  status: 'streaming' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
}

export interface TraceProjection {
  sessionId: string;
  turns: TraceTurn[];
  activeTurnIndex: number; // -1 = 无 streaming
}
