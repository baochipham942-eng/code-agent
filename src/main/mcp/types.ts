// ============================================================================
// MCP Types - Model Context Protocol 类型定义
// ============================================================================

import type { ToolDefinition, ToolResult } from '../../shared/types';

// ----------------------------------------------------------------------------
// Server Configuration Types
// ----------------------------------------------------------------------------

/**
 * Stdio 服务器配置 (本地命令行)
 */
export interface MCPStdioServerConfig {
  name: string;
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

/**
 * SSE 服务器配置 (远程 HTTP - SSE Transport)
 */
export interface MCPSSEServerConfig {
  name: string;
  type: 'sse';
  serverUrl: string;
  enabled: boolean;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/**
 * HTTP Streamable 服务器配置 (远程 HTTP - Streamable Transport)
 * 这是 MCP 推荐的现代传输协议
 */
export interface MCPHttpStreamableServerConfig {
  name: string;
  type: 'http-streamable';
  serverUrl: string;
  enabled: boolean;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
  /** Required environment variables (server disabled if missing) */
  requiredEnvVars?: string[];
}

/**
 * 进程内服务器配置 (内置工具，无需 IPC)
 * 用于将内置工具暴露为 MCP 服务，避免跨进程通信开销
 */
export interface MCPInProcessServerConfig {
  name: string;
  type: 'in-process';
  enabled: boolean;
  /**
   * 进程内服务器实例工厂函数
   * 返回一个实现了 InProcessMCPServerInterface 的实例
   */
  serverFactory?: () => InProcessMCPServerInterface;
}

/**
 * 统一的服务器配置类型
 */
export type MCPServerConfig = MCPStdioServerConfig | MCPSSEServerConfig | MCPHttpStreamableServerConfig | MCPInProcessServerConfig;

// ----------------------------------------------------------------------------
// MCP Entity Types
// ----------------------------------------------------------------------------

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: unknown;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  serverName: string;
}

// ----------------------------------------------------------------------------
// Server State Types
// ----------------------------------------------------------------------------

/**
 * 服务器连接状态
 */
export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * 服务器状态
 */
export interface MCPServerState {
  config: MCPServerConfig;
  status: MCPServerStatus;
  error?: string;
  toolCount: number;
  resourceCount: number;
}

// ----------------------------------------------------------------------------
// In-Process Server Interface
// ----------------------------------------------------------------------------

/**
 * 进程内 MCP 服务器接口
 * 实现此接口的类可以作为进程内 MCP 服务器使用
 */
export interface InProcessMCPServerInterface {
  /**
   * 服务器名称
   */
  readonly name: string;

  /**
   * 获取可用工具列表
   */
  listTools(): Promise<MCPTool[]>;

  /**
   * 获取可用资源列表
   */
  listResources(): Promise<MCPResource[]>;

  /**
   * 获取可用提示列表
   */
  listPrompts(): Promise<MCPPrompt[]>;

  /**
   * 调用工具
   * @param toolName 工具名称
   * @param args 工具参数
   * @param toolCallId 工具调用 ID
   */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string
  ): Promise<ToolResult>;

  /**
   * 读取资源
   * @param uri 资源 URI
   */
  readResource(uri: string): Promise<string>;

  /**
   * 获取提示内容
   * @param promptName 提示名称
   * @param args 提示参数
   */
  getPrompt(promptName: string, args?: Record<string, string>): Promise<string>;

  /**
   * 启动服务器（可选，用于初始化）
   */
  start?(): Promise<void>;

  /**
   * 停止服务器（可选，用于清理）
   */
  stop?(): Promise<void>;
}

// ----------------------------------------------------------------------------
// Tool Handler Types (for InProcessMCPServer)
// ----------------------------------------------------------------------------

/**
 * 工具处理器函数类型
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  toolCallId: string
) => Promise<ToolResult>;

/**
 * 工具注册信息
 */
export interface ToolRegistration {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * 资源处理器函数类型
 */
export type ResourceHandler = (uri: string) => Promise<string>;

/**
 * 资源注册信息
 */
export interface ResourceRegistration {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  handler: ResourceHandler;
}

/**
 * 提示处理器函数类型
 */
export type PromptHandler = (args?: Record<string, string>) => Promise<string>;

/**
 * 提示注册信息
 */
export interface PromptRegistration {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  handler: PromptHandler;
}

// ----------------------------------------------------------------------------
// Type Guards
// ----------------------------------------------------------------------------

/**
 * 判断是否为 Stdio 服务器配置
 */
export function isStdioConfig(config: MCPServerConfig): config is MCPStdioServerConfig {
  return config.type === undefined || config.type === 'stdio';
}

/**
 * 判断是否为 SSE 服务器配置
 */
export function isSSEConfig(config: MCPServerConfig): config is MCPSSEServerConfig {
  return config.type === 'sse';
}

/**
 * 判断是否为 HTTP Streamable 服务器配置
 */
export function isHttpStreamableConfig(config: MCPServerConfig): config is MCPHttpStreamableServerConfig {
  return config.type === 'http-streamable';
}

/**
 * 判断是否为进程内服务器配置
 */
export function isInProcessConfig(config: MCPServerConfig): config is MCPInProcessServerConfig {
  return config.type === 'in-process';
}
