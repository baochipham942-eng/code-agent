// ============================================================================
// Trace Types - Turn-based trace view projection
// ============================================================================

export type TraceNodeType = 'user' | 'assistant_text' | 'tool_call' | 'system';

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
    _streaming?: boolean;
  };
  reasoning?: string;
  thinking?: string;
  subtype?: 'compaction' | 'error' | 'skill_status';
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
