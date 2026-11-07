// ============================================================================
// Trace Types - Turn-based trace view projection
// ============================================================================

export type TraceNodeType =
  | 'user'
  | 'assistant_text'
  | 'tool_call'
  | 'system'
  | 'neo_work_card'
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
    stepLabel?: import('./tool').ToolStepLabelKey;
    targetContext?: import('./tool').ToolCallTargetContext;
    expectedOutcome?: string;
  };
  reasoning?: string;
  thinking?: string;
  subtype?: 'compaction' | 'error' | 'skill_status' | 'goal_notice' | 'model_fallback' | 'voice_call_summary' | 'context_compression_signal';
  attachments?: import('./message').MessageAttachment[];
  artifacts?: import('./message').Artifact[];
  modelDecision?: import('./modelDecision').ModelDecisionEventData;
  metadata?: import('./message').MessageMetadata;
  feedbackEligible?: boolean;
  neoWorkCard?: import('./tag').NeoWorkCardDetail;
  launchRequest?: import('./swarm').SwarmLaunchRequest;
  turnTimeline?: import('./turnTimeline').TurnTimelineNode;
  /**
   * 连续同因失败折叠（N-UI-AGENT-ERROR-REPEAT-COLLAPSE）：投影层从消息列表推导的
   * 同因连续段信息，不落库。latest=false 的失败轮渲染一行灰字「没有回复 · 原因」，
   * 段内最新一轮渲染整卡（runLength≥2 时附带「连续 N 次」说明）；duplicate=true 是
   * 同一轮内的重复失败上报，不渲染。同一消息的全部节点携带同一对象。缺失时按单次
   * 失败（runLength 1 / latest）处理。
   */
  agentErrorRun?: AgentErrorRunInfo;
}

/**
 * 连续同因失败折叠的推导结果形状（见 TraceNode.agentErrorRun）。
 */
export interface AgentErrorRunInfo {
  /** 本段连续同因失败中的第几次（从 1 起） */
  runLength: number;
  /** 段内最新一轮渲染整卡；早先的压成一行灰字 */
  latest: boolean;
  /**
   * 同一轮内的重复失败上报（两条用户消息之间没有新的用户输入，同因再次落错——
   * web 路径 host 结构化标记与原始供应商报错各落一条）：同一失败，不再渲染。
   */
  duplicate?: boolean;
}

export interface TraceTurn {
  turnNumber: number;
  turnId: string;
  nodes: TraceNode[];
  status: 'streaming' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
  /** Backend-authoritative filesystem diff; absent on legacy/fallback turns. */
  turnDiff?: import('./turnDiff').TurnDiffEventData;
  /**
   * 语音派活轮的结局印章（X5.5-A2-a）：host 查过产物证据后落库、投影层按 workItemId
   * 对回这一轮。任务卡的「已完成 / 已结束·待核验」只认它；缺印章就不报结局。
   */
  voiceWorkOutcome?: 'done' | 'unverified' | 'failed' | 'cancelled';
}

export interface TraceProjection {
  sessionId: string;
  turns: TraceTurn[];
  activeTurnIndex: number; // -1 = 无 streaming
}
