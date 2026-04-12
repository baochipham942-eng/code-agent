// ============================================================================
// Agent Routing Types - Configuration-level Agent Routing
// ============================================================================

/**
 * Agent 配置定义
 * 用于定义一个可被路由系统选择的 Agent
 */
export interface AgentRoutingConfig {
  /** Agent 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** System Prompt 内容 */
  systemPrompt: string;
  /** 可用工具列表（留空表示所有工具） */
  tools?: string[];
  /** 模型覆盖配置 */
  modelOverride?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 是否启用 */
  enabled?: boolean;
  /** 绑定规则列表 */
  bindings?: AgentBinding[];
  /** 标签用于分类 */
  tags?: string[];
}

/**
 * Agent 绑定规则
 * 定义 Agent 何时被激活
 */
export interface AgentBinding {
  /** 绑定类型 */
  type: BindingType;
  /** 匹配规则 */
  match: BindingMatch;
  /** 优先级（数值越高优先级越高）默认 0 */
  priority?: number;
}

/**
 * 绑定类型
 */
export type BindingType =
  | 'directory'     // 目录匹配
  | 'file_pattern'  // 文件模式匹配
  | 'keyword'       // 关键词匹配
  | 'intent'        // 意图匹配（语义分析）
  | 'always';       // 始终激活

/**
 * 绑定匹配条件
 */
export interface BindingMatch {
  /** 目录模式（支持 glob）*/
  directory?: string;
  /** 文件模式（支持 glob）*/
  filePattern?: string;
  /** 关键词列表（任意一个匹配即可）*/
  keywords?: string[];
  /** 意图描述（用于语义匹配）*/
  intent?: string;
  /** 是否否定匹配 */
  negate?: boolean;
}

/**
 * 路由解析结果
 */
export interface RoutingResolution {
  /** 匹配的 Agent 配置 */
  agent: AgentRoutingConfig;
  /** 匹配得分（用于多匹配时选择最佳） */
  score: number;
  /** 匹配的绑定规则 */
  matchedBinding?: AgentBinding;
  /** 匹配原因描述 */
  reason: string;
}

/**
 * 路由上下文
 * 用于路由决策的上下文信息
 */
export interface RoutingContext {
  /** 当前工作目录 */
  workingDirectory: string;
  /** 用户消息内容 */
  userMessage: string;
  /** 当前打开的文件路径（如有） */
  activeFile?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Agents 配置文件结构
 * 存储在 .claude/agents.json
 */
export interface AgentsConfigFile {
  /** 配置版本 */
  version: string;
  /** Agent 列表 */
  agents: AgentRoutingConfig[];
  /** 默认 Agent ID（无匹配时使用） */
  defaultAgentId?: string;
  /** 最后更新时间 */
  lastUpdated?: number;
}

/**
 * Agent 路由事件
 */
export interface AgentRoutingEvent {
  type: 'agent_selected' | 'agent_fallback' | 'no_match';
  agentId?: string;
  agentName?: string;
  reason: string;
  context: RoutingContext;
}
