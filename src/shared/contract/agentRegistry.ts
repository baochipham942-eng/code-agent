// ============================================================================
// Agent Registry - 渲染端 / 主进程共享类型
// ============================================================================
//
// 主进程 src/main/agent/agentRegistry.ts 是单一真理源（builtin + user + project）。
// 这里只暴露跨进程序列化后的列表条目类型，供 IPC + 渲染端 store 共用。

export type AgentSource = 'builtin' | 'user' | 'project';

export interface AgentListEntry {
  id: string;
  name: string;
  description: string;
  source: AgentSource;
  /** Builtin tier 字段；自定义 agent 可能复用 'balanced' 字符串 */
  modelTier: string;
  readonly: boolean;
  tools: string[];
}

/** 主进程推送到渲染端的事件 payload（IPC_CHANNELS.AGENTS_CHANGED） */
export interface AgentsChangedEvent {
  agents: AgentListEntry[];
}
