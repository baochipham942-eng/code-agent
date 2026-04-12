// ============================================================================
// Agent History Types - 已完成 Agent 运行记录
// ============================================================================

export interface CompletedAgentRun {
  id: string;
  name: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime: number;
  durationMs: number;
  tokenUsage: { input: number; output: number };
  toolCalls: number;
  resultPreview?: string;
  sessionId: string;
}
