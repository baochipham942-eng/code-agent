// ============================================================================
// Citation Types - 引用溯源共享类型
// ============================================================================

export type CitationType = 'file' | 'url' | 'cell' | 'query' | 'memory';

export interface Citation {
  id: string;
  type: CitationType;
  /** 来源标识，如 "src/main/agent/agentLoop.ts" 或 "https://..." */
  source: string;
  /** 位置标识，如 "line:42" 或 "cell:B15" */
  location?: string;
  /** 展示标签，如 "[1] agentLoop.ts:42" */
  label: string;
  toolCallId: string;
  timestamp: number;
}
