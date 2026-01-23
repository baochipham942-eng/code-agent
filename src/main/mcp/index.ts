// ============================================================================
// MCP Module - Model Context Protocol 统一导出
// ============================================================================

// Types
export * from './types';

// Client
export {
  MCPClient,
  getMCPClient,
  initMCPClient,
  refreshMCPServersFromCloud,
  getDefaultMCPServers,
  DEFAULT_MCP_SERVERS,
} from './mcpClient';

// In-Process Server
export { InProcessMCPServer, createInProcessServer } from './inProcessServer';

// Server (for exposing Code Agent as MCP server)
export { CodeAgentMCPServer, getMCPServer } from './mcpServer';

// Log Bridge
export { logBridge, type CommandHandler } from './logBridge';

// Log Collector
export {
  logCollector,
  type LogEntry,
  type LogLevel,
  type LogSource,
  type LogStatus,
} from './logCollector';
