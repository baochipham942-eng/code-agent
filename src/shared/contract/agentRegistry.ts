// ============================================================================
// Agent Registry - 渲染端 / 主进程共享类型
// ============================================================================
//
// 主进程 src/host/agent/agentRegistry.ts 是单一真理源（builtin + user + project）。
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
  /** 该条目是角色资产（agents/<id>.md 且存在 roles/<id>/ 目录）——面板上与 agent 分组显示 */
  isRole?: boolean;
}

/**
 * 系统型内置 agent：面向内部流程（长命令监控 / 复盘 / 工作流提炼），
 * 对协作者没有"选它执行本轮"的语义 —— 不进 /agent 选择面板（registry 本身保留）。
 */
export const PANEL_HIDDEN_BUILTIN_AGENT_IDS: readonly string[] = ['awaiter', 'dream', 'distill'];

/** /agent 面板可见性过滤（只隐藏系统型内置；用户自建 agent / 角色照常显示） */
export function isPanelVisibleAgent(entry: Pick<AgentListEntry, 'id' | 'source'>): boolean {
  return !(entry.source === 'builtin' && PANEL_HIDDEN_BUILTIN_AGENT_IDS.includes(entry.id));
}

/** 主进程推送到渲染端的事件 payload（IPC_CHANNELS.AGENTS_CHANGED） */
export interface AgentsChangedEvent {
  agents: AgentListEntry[];
}
