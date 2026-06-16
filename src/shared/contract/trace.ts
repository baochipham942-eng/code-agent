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
  messageId?: string;
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
    liveOutput?: import('./tool').ToolLiveOutput;
    _streaming?: boolean;
    /** 结局优先：本次失败的工具调用之后，同一轮里又出现了成功（重试成功/最终答案），
     *  说明这次失败已被恢复，UI 应降级为脚注而非顶红 failed。由投影层标记。 */
    recovered?: boolean;
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
  subtype?: 'compaction' | 'error' | 'skill_status' | 'goal_notice' | 'model_fallback';
  attachments?: import('./message').MessageAttachment[];
  artifacts?: import('./message').Artifact[];
  modelDecision?: import('./modelDecision').ModelDecisionEventData;
  metadata?: import('./message').MessageMetadata;
  feedbackEligible?: boolean;
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
