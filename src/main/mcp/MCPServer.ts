// ============================================================================
// MCP Server - 暴露 Code Agent 日志和状态给外部 MCP 客户端
// ============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { logCollector, LogEntry, LogSource, LogStatus } from './LogCollector.js';

// Log Bridge URL for fetching logs from running Electron app
const LOG_BRIDGE_URL = 'http://127.0.0.1:51820';

// Fetch logs from the HTTP bridge (when running as standalone MCP server)
async function fetchLogsFromBridge(source: string, count: number = 50): Promise<LogEntry[]> {
  try {
    const response = await fetch(`${LOG_BRIDGE_URL}/logs/${source}?count=${count}`);
    if (response.ok) {
      return await response.json();
    }
    return [];
  } catch {
    // Bridge not available, return local collector logs
    return [];
  }
}

async function fetchStatusFromBridge(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${LOG_BRIDGE_URL}/status`);
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// MCP Server Class
// ----------------------------------------------------------------------------

export class CodeAgentMCPServer {
  private server: Server;
  private isRunning: boolean = false;

  constructor() {
    this.server = new Server(
      {
        name: 'code-agent',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  // --------------------------------------------------------------------------
  // Handler Setup
  // --------------------------------------------------------------------------

  private setupHandlers(): void {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: 'code-agent://logs/browser',
            name: 'Browser Logs',
            description: 'Browser automation operation logs from Playwright',
            mimeType: 'text/plain',
          },
          {
            uri: 'code-agent://logs/agent',
            name: 'Agent Logs',
            description: 'Agent execution logs (reasoning, decisions)',
            mimeType: 'text/plain',
          },
          {
            uri: 'code-agent://logs/tool-calls',
            name: 'Tool Call Logs',
            description: 'Tool invocation logs with parameters and results',
            mimeType: 'text/plain',
          },
          {
            uri: 'code-agent://logs/all',
            name: 'All Logs',
            description: 'Combined logs from all sources',
            mimeType: 'text/plain',
          },
          {
            uri: 'code-agent://status',
            name: 'Agent Status',
            description: 'Current agent status and statistics',
            mimeType: 'application/json',
          },
        ],
      };
    });

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (uri === 'code-agent://logs/browser') {
        // Try bridge first, then local collector
        let logs = await fetchLogsFromBridge('browser', 50);
        if (logs.length === 0) {
          logs = logCollector.getLogs('browser', 50);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: this.formatLogs(logs),
            },
          ],
        };
      }

      if (uri === 'code-agent://logs/agent') {
        let logs = await fetchLogsFromBridge('agent', 50);
        if (logs.length === 0) {
          logs = logCollector.getLogs('agent', 50);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: this.formatLogs(logs),
            },
          ],
        };
      }

      if (uri === 'code-agent://logs/tool-calls') {
        let logs = await fetchLogsFromBridge('tool', 50);
        if (logs.length === 0) {
          logs = logCollector.getLogs('tool', 50);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: this.formatLogs(logs),
            },
          ],
        };
      }

      if (uri === 'code-agent://logs/all') {
        let logs = await fetchLogsFromBridge('all', 100);
        if (logs.length === 0) {
          logs = logCollector.getAllLogs(100);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: this.formatLogs(logs),
            },
          ],
        };
      }

      if (uri === 'code-agent://status') {
        let status: Record<string, unknown> | LogStatus | null = await fetchStatusFromBridge();
        if (!status) {
          status = logCollector.getStatus();
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown resource: ${uri}`);
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'get_logs',
            description: 'Get logs from Code Agent by source type',
            inputSchema: {
              type: 'object',
              properties: {
                source: {
                  type: 'string',
                  enum: ['browser', 'agent', 'tool', 'all'],
                  description: 'Log source to retrieve',
                },
                count: {
                  type: 'number',
                  description: 'Number of log entries to return (default: 20)',
                },
                level: {
                  type: 'string',
                  enum: ['INFO', 'WARN', 'ERROR', 'DEBUG'],
                  description: 'Filter by log level',
                },
              },
              required: ['source'],
            },
          },
          {
            name: 'clear_logs',
            description: 'Clear logs from a specific source or all sources',
            inputSchema: {
              type: 'object',
              properties: {
                source: {
                  type: 'string',
                  enum: ['browser', 'agent', 'tool', 'all'],
                  description: 'Log source to clear',
                },
              },
              required: ['source'],
            },
          },
          {
            name: 'get_status',
            description: 'Get current Code Agent status and statistics',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'execute_command',
            description: 'Execute a command on the running Code Agent. Commands: browser_action, run_test, ping',
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  enum: ['browser_action', 'run_test', 'ping'],
                  description: 'Command to execute',
                },
                params: {
                  type: 'object',
                  description: 'Command parameters. For browser_action: {action, url, selector, text, tabId}. For run_test: {name: "self_test" | "generation_selector"}',
                },
              },
              required: ['command'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'get_logs') {
        const source = (args?.source as string) || 'all';
        const count = (args?.count as number) || 20;
        const level = args?.level as string | undefined;

        let logs: LogEntry[];
        if (source === 'all') {
          logs = logCollector.getAllLogs(count);
        } else {
          logs = logCollector.getLogs(source as LogSource, count);
        }

        // Filter by level if specified
        if (level) {
          logs = logs.filter((log) => log.level === level);
        }

        return {
          content: [
            {
              type: 'text',
              text: this.formatLogs(logs),
            },
          ],
        };
      }

      if (name === 'clear_logs') {
        const source = (args?.source as string) || 'all';
        if (source === 'all') {
          logCollector.clearAll();
        } else {
          logCollector.clear(source as LogSource);
        }
        return {
          content: [
            {
              type: 'text',
              text: `Cleared ${source} logs`,
            },
          ],
        };
      }

      if (name === 'get_status') {
        const status = logCollector.getStatus();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      if (name === 'execute_command') {
        const command = args?.command as string;
        const params = (args?.params as Record<string, unknown>) || {};

        if (!command) {
          return {
            content: [{ type: 'text', text: 'Error: Missing command' }],
            isError: true,
          };
        }

        try {
          const response = await fetch(`${LOG_BRIDGE_URL}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, params }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            return {
              content: [{ type: 'text', text: `Error: ${errorText}` }],
              isError: true,
            };
          }

          const result = await response.json();
          return {
            content: [
              {
                type: 'text',
                text: result.success
                  ? result.output || 'Command executed successfully'
                  : `Error: ${result.error}`,
              },
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to connect to Code Agent. Make sure it's running. Error: ${error}`,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private formatLogs(logs: LogEntry[]): string {
    if (logs.length === 0) {
      return 'No logs available.';
    }

    return logs
      .map((log) => {
        const time = log.timestamp.toISOString().split('T')[1].split('.')[0];
        const source = log.source.toUpperCase().padEnd(7);
        const level = log.level.padEnd(5);
        return `[${time}] [${source}] [${level}] ${log.message}`;
      })
      .join('\n');
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[MCPServer] Already running');
      return;
    }

    console.log('[MCPServer] Starting Code Agent MCP Server...');

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.isRunning = true;
    console.log('[MCPServer] Code Agent MCP Server started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[MCPServer] Stopping Code Agent MCP Server...');
    await this.server.close();
    this.isRunning = false;
    console.log('[MCPServer] Code Agent MCP Server stopped');
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let serverInstance: CodeAgentMCPServer | null = null;

export function getMCPServer(): CodeAgentMCPServer {
  if (!serverInstance) {
    serverInstance = new CodeAgentMCPServer();
  }
  return serverInstance;
}
