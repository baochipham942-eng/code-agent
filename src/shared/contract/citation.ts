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

  // ============================================================================
  // 语义元数据（产品视角升级 — P0 内核）
  // 让引用从"贴个 chip"升级为"贴个理由"。模型 emit citation 时同步输出，
  // UI（MemoryCitationGroup 等）优先消费，未提供时退化为现有 chip 显示。
  // ============================================================================

  /** "为什么用这段引用"的一句话语义摘要（如 "identified Clash Verge config dir"） */
  rationale?: string;

  /** 结构化行号范围（替代 location 中的 "line:42-50" 字符串） */
  lineRange?: [number, number];
}
