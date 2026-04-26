// ============================================================================
// Tool Types
// ============================================================================
import type { ModelConfig } from './model';
import type { PermissionRequest } from './permission';

export type PermissionLevel = 'read' | 'write' | 'execute' | 'network';

/**
 * 工具分类标签
 * 用于 ToolSearch 工具发现和搜索匹配
 */
export type ToolTag =
  | 'file'       // 文件操作
  | 'search'     // 搜索相关
  | 'shell'      // Shell/命令执行
  | 'network'    // 网络请求
  | 'mcp'        // MCP 协议
  | 'planning'   // 规划和任务管理
  | 'memory'     // 记忆系统
  | 'vision'     // 视觉/截图
  | 'multiagent' // 多代理
  | 'evolution'  // 自我进化
  | 'document'   // 文档处理
  | 'media';     // 媒体生成

/**
 * 工具来源类型
 */
export type ToolSource = 'builtin' | 'mcp' | 'dynamic';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  requiresPermission: boolean;
  permissionLevel: PermissionLevel;

  // ============================================================================
  // ToolSearch 延迟加载支持 (v0.17+)
  // ============================================================================

  /** 是否为核心工具（默认发送给模型） */
  isCore?: boolean;

  /** 工具分类标签（用于搜索匹配） */
  tags?: ToolTag[];

  /** 工具别名（用于搜索匹配，如 'pdf' 匹配 'read_pdf'） */
  aliases?: string[];

  /** 来源类型 */
  source?: ToolSource;

  /** MCP 服务器名称（仅 MCP 工具） */
  mcpServer?: string;

  /** 动态描述生成器（优先于静态 description） */
  dynamicDescription?: () => string;
}

export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchemaProperty;
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  workingDirectory: string;
  modelConfig: ModelConfig;
  requestPermission: (request: PermissionRequest) => Promise<boolean>;
  emit: (event: string, data: unknown) => void;
  /** 当前工具调用的 ID（用于 subagent 追踪） */
  currentToolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Result is attached by the UI when tool_call_end event is received
  result?: ToolResult;
  // 流式工具调用的临时属性
  _streaming?: boolean; // 标记是否正在流式接收中
  _argumentsRaw?: string; // 累积的原始参数字符串（用于增量解析）

  // ============================================================================
  // 语义元数据（产品视角升级 — P0 内核）
  // 模型在 tool_call envelope 中输出（不在 arguments 里），各 provider parser 提取
  // 后写入。UI 优先消费这些字段，未提供时 fallback 到现有 hardcoded 渲染逻辑。
  // ============================================================================

  /** 一行自然语言动词短语（如 "Open Baidu search Claude"），UI 标题首选 */
  shortDescription?: string;

  /** 操作目标上下文，用于 UI 渲染目标 app logo / MCP server 名等 */
  targetContext?: ToolCallTargetContext;

  /** 可选的预期成果（用于失败诊断和未来 UI 增强） */
  expectedOutcome?: string;
}

export interface ToolCallTargetContext {
  kind?: 'app' | 'browser' | 'mcp_server' | 'file' | 'memory';
  /** 显示用名称（如 "WeChat" / "Exa" / "MEMORY.md"） */
  label?: string;
  /** 图标提示：bundleId（app）/ domain（browser）/ server slug（mcp_server）等 */
  iconHint?: string;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
  outputPath?: string; // Explicit path for file-producing tools (preferred over regex extraction)
  duration?: number;
  metadata?: Record<string, unknown>; // 工具返回的元数据（如 imagePath, imageBase64 等）
}
