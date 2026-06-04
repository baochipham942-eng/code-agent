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
import { logCollector, type LogEntry, type LogLevel, type LogSource, type LogStatus } from './logCollector.js';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve, sep as pathSep } from 'node:path';
import { CONFIG_DIR_NEW } from '../config/configPaths.js';

// Log Bridge URL for fetching logs from running Electron app
const LOG_BRIDGE_URL = 'http://127.0.0.1:51820';

// 设计决策（WS5b）：本 MCP server 只暴露只读/安全能力。控屏（computer）/反向命令执行
// （execute_command）不 MCP 化——外部 agent 要控屏必须由 Neo 主导（走 agentEngine），不能
// 反向通过 MCP 控制本机。详见 docs/designs/ws5b-computeruse-mcp-security.md。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLogSource(value: unknown): LogSource | null {
  return value === 'browser' || value === 'agent' || value === 'tool' ? value : null;
}

function parseLogLevel(value: unknown): LogLevel | null {
  return value === 'INFO' || value === 'WARN' || value === 'ERROR' || value === 'DEBUG' ? value : null;
}

function parseLogEntry(value: unknown): LogEntry | null {
  if (!isRecord(value)) return null;
  const source = parseLogSource(value.source);
  const level = parseLogLevel(value.level);
  if (!source || !level || typeof value.message !== 'string') return null;

  const timestamp = value.timestamp instanceof Date
    ? value.timestamp
    : typeof value.timestamp === 'string' || typeof value.timestamp === 'number'
      ? new Date(value.timestamp)
      : null;
  if (!timestamp || Number.isNaN(timestamp.getTime())) return null;

  return {
    timestamp,
    source,
    level,
    message: value.message,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function parseLogEntries(value: unknown): LogEntry[] {
  return Array.isArray(value)
    ? value.map(parseLogEntry).filter((entry): entry is LogEntry => entry !== null)
    : [];
}

function parseStatus(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

// Fetch logs from the HTTP bridge (when running as standalone MCP server)
async function fetchLogsFromBridge(source: string, count: number = 50): Promise<LogEntry[]> {
  try {
    const response = await fetch(`${LOG_BRIDGE_URL}/logs/${source}?count=${count}`);
    if (response.ok) {
      const payload: unknown = await response.json();
      return parseLogEntries(payload);
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
      const payload: unknown = await response.json();
      return parseStatus(payload);
    }
    return null;
  } catch {
    return null;
  }
}

// P3-A：从 bridge 拉只读任务状态（/tasks /task-status /projects）。
// app 未运行时 fetch 抛错 → 返回 { _unavailable } 提示，由调用方友好展示。
async function fetchJsonFromBridge(pathAndQuery: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetch(`${LOG_BRIDGE_URL}${pathAndQuery}`);
    const data: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch {
    return {
      ok: false,
      status: 0,
      data: { _unavailable: true, message: 'Agent Neo is not running (log bridge unreachable). Start the app to query live task status.' },
    };
  }
}

// ----------------------------------------------------------------------------
// MCP Server Class
// ----------------------------------------------------------------------------

export class CodeAgentMCPServer {
  private server: Server;
  private isRunning: boolean = false;
  /** 解析 eval 结果时的工作目录（其下的 .code-agent/ 存放 eval-baseline.json / eval-trend.json）。 */
  private readonly workingDirectory: string;

  constructor(options?: { transport?: string; port?: number; host?: string; enableWriteTools?: boolean; workingDirectory?: string }) {
    this.workingDirectory = options?.workingDirectory ?? process.cwd();
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

    // List available tools — 只读/安全能力；控屏 / 反向命令执行不 MCP 化（见文件头注释）。
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'get_logs',
            description: 'Get logs from Agent Neo by source type',
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
            name: 'get_status',
            description: 'Get current Agent Neo status and statistics',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'screenshot',
            description: 'Capture screen or specific window via the running Agent Neo. Returns saved PNG path. Set analyze=true to get AI description of contents.',
            inputSchema: {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['screen', 'window'] },
                windowName: { type: 'string' },
                outputPath: { type: 'string' },
                region: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                  },
                },
                analyze: { type: 'boolean' },
                prompt: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          {
            name: 'eval-query',
            description: 'Query Agent Neo evaluation results (read-only). Reads the eval baseline (global pass rate / average score / per-case pass-fail-score) and recent run trend from the working directory\'s .code-agent/eval-baseline.json and eval-trend.json. Useful for an external agent to inspect Neo\'s own benchmark health.',
            inputSchema: {
              type: 'object',
              properties: {
                view: {
                  type: 'string',
                  enum: ['summary', 'cases', 'trend', 'all'],
                  description: 'summary = global metrics; cases = per-case results; trend = recent run history; all = everything. Default summary.',
                },
                status: {
                  type: 'string',
                  enum: ['passed', 'failed', 'all'],
                  description: '[cases] Filter case results by status. Default all.',
                },
                trendCount: {
                  type: 'number',
                  description: '[trend] Number of most-recent trend points to return. Default 10.',
                },
                workingDirectory: {
                  type: 'string',
                  description: 'Override the working directory whose .code-agent/ holds eval results. Defaults to the server working directory.',
                },
              },
            },
          },
          {
            name: 'appshots-query',
            description: 'List and read Agent Neo\'s persisted window captures (appshots) — read-only history of user-triggered hotkey window snapshots stored under <CODE_AGENT_DATA_DIR or ~/.code-agent>/appshots/. This does NOT trigger a live capture (that needs the running app); it reads past captures from disk. Set includeDataUrl=true (or pass an explicit path inside the appshots dir) to embed a capture\'s PNG as image content.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Max captures to list, newest first. Default 10.' },
                includeDataUrl: { type: 'boolean', description: 'Embed the newest capture (or the path-specified one) as image content. Default false (paths only).' },
                path: { type: 'string', description: 'Absolute path of a specific capture to read as image content. Must resolve inside the appshots directory.' },
              },
            },
          },
          {
            name: 'neo_list_tasks',
            description: 'List Agent Neo\'s current and recent tasks (read-only, metadata only). Returns recent swarm runs (status / progress counts / token & cost totals / timestamps) plus live in-memory session states (running/paused/queued/idle). Does NOT expose task prompts, agent outputs, or file paths — only the shape of activity. Requires Agent Neo to be running.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Max swarm runs to return, newest first. Default 20.' },
              },
            },
          },
          {
            name: 'neo_get_task_status',
            description: 'Get the detailed status of a specific Agent Neo swarm run by id (read-only, metadata only). Returns run-level status/progress/token/cost, per-agent rollups (status/tokens/duration/enum failure category, file-change COUNT only), and an event summary (counts by type & level). Does NOT expose event message text, error free-text, or changed file paths. Requires Agent Neo to be running.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'The swarm run id (from neo_list_tasks).' },
              },
              required: ['id'],
            },
          },
          {
            name: 'neo_list_projects',
            description: 'List Agent Neo\'s projects and their goal status (read-only, metadata only). Returns project name/status/timestamps and per-project goal/role/session counts plus goal status breakdown. Does NOT expose project descriptions or goal/verify/review instruction text — only structural status. Requires Agent Neo to be running.',
            inputSchema: {
              type: 'object',
              properties: {
                includeArchived: { type: 'boolean', description: 'Include archived projects. Default false.' },
              },
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

      if (name === 'screenshot') {
        try {
          const { screenshotTool } = await import('../tools/vision/screenshot.js');
          const ctx = {
            workingDirectory: pathJoin(homedir(), CONFIG_DIR_NEW),
            requestPermission: async () => true,
          };
          const result = await screenshotTool.execute((args ?? {}) as Record<string, unknown>, ctx as never);
          return {
            content: [
              {
                type: 'text',
                text: result.success
                  ? (result.output ?? result.outputPath ?? 'OK')
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
                text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      if (name === 'eval-query') {
        try {
          const view = (args?.view as string) || 'summary';
          const statusFilter = (args?.status as string) || 'all';
          const trendCount = typeof args?.trendCount === 'number' ? (args.trendCount as number) : 10;
          const workDir = (args?.workingDirectory as string) || this.workingDirectory;

          const { BaselineManager } = await import('../testing/ci/baselineManager.js');
          const { TrendTracker } = await import('../testing/ci/trendTracker.js');
          const baseline = await new BaselineManager(workDir).load();

          if (!baseline && (view === 'summary' || view === 'cases')) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No eval baseline found under ${pathJoin(workDir, CONFIG_DIR_NEW)}. Run an evaluation first, or pass workingDirectory pointing at a project whose .code-agent/ holds eval-baseline.json.`,
                },
              ],
              isError: true,
            };
          }

          const out: Record<string, unknown> = { workingDirectory: workDir };
          if (baseline && (view === 'summary' || view === 'all')) {
            out.summary = {
              ...baseline.globalMetrics,
              updatedAt: baseline.updatedAt,
              updatedBy: baseline.updatedBy,
            };
          }
          if (baseline && (view === 'cases' || view === 'all')) {
            const cases = Object.entries(baseline.caseResults)
              .filter(([, r]) => statusFilter === 'all' || r.status === statusFilter)
              .map(([testId, r]) => ({
                testId,
                status: r.status,
                score: r.score,
                lastPassedAt: r.lastPassedAt ?? null,
              }));
            out.caseCount = cases.length;
            out.cases = cases;
          }
          if (view === 'trend' || view === 'all') {
            out.trend = await new TrendTracker(workDir).getRecent(trendCount);
          }

          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (error) {
          return {
            content: [
              { type: 'text', text: `eval-query failed: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      }

      if (name === 'appshots-query') {
        try {
          const limit = typeof args?.limit === 'number' ? (args.limit as number) : 10;
          const includeDataUrl = args?.includeDataUrl === true;
          const explicitPath = args?.path as string | undefined;

          const dataDir = process.env.CODE_AGENT_DATA_DIR || pathJoin(homedir(), CONFIG_DIR_NEW);
          const appshotsDir = pathJoin(dataDir, 'appshots');
          const appshotsRoot = pathResolve(appshotsDir);

          // 路径穿越防护：显式 path 必须落在 appshots 目录内。
          const resolveInsideDir = (p: string): string | null => {
            const resolved = pathResolve(p);
            return resolved === appshotsRoot || resolved.startsWith(appshotsRoot + pathSep) ? resolved : null;
          };

          let fileNames: string[];
          try {
            fileNames = (await fsp.readdir(appshotsDir)).filter(
              (f) => f.startsWith('appshot-') && f.endsWith('.png'),
            );
          } catch {
            return {
              content: [{ type: 'text', text: `No appshots directory at ${appshotsDir} (no captures yet).` }],
            };
          }

          const captures = await Promise.all(
            fileNames.map(async (f) => {
              const full = pathJoin(appshotsDir, f);
              let sizeBytes = 0;
              try {
                sizeBytes = (await fsp.stat(full)).size;
              } catch {
                /* ignore unreadable file */
              }
              const matched = /appshot-(\d+)\.png$/.exec(f);
              const capturedAtMs = matched ? Number(matched[1]) : 0;
              return { path: full, fileName: f, capturedAtMs, sizeBytes };
            }),
          );
          captures.sort((a, b) => b.capturedAtMs - a.capturedAtMs);
          const limited = captures.slice(0, Math.max(0, limit));

          const content: Array<
            { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
          > = [
            {
              type: 'text',
              text: JSON.stringify({ appshotsDir, count: captures.length, captures: limited }, null, 2),
            },
          ];

          if (includeDataUrl || explicitPath) {
            const target = explicitPath ? resolveInsideDir(explicitPath) : (limited[0]?.path ?? null);
            if (explicitPath && !target) {
              return {
                content: [
                  { type: 'text', text: `Refused: path is outside the appshots directory (${appshotsDir}).` },
                ],
                isError: true,
              };
            }
            if (target) {
              try {
                const buf = await fsp.readFile(target);
                content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
              } catch (e) {
                content.push({
                  type: 'text',
                  text: `Failed to read capture ${target}: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            }
          }

          return { content };
        } catch (error) {
          return {
            content: [
              { type: 'text', text: `appshots-query failed: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      }

      if (name === 'neo_list_tasks') {
        const limit = typeof args?.limit === 'number' ? (args.limit as number) : undefined;
        const query = limit && limit > 0 ? `/tasks?limit=${limit}` : '/tasks';
        const { ok, data } = await fetchJsonFromBridge(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: !ok,
        };
      }

      if (name === 'neo_get_task_status') {
        const id = args?.id as string | undefined;
        if (!id) {
          return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
        }
        const { ok, data } = await fetchJsonFromBridge(`/task-status?id=${encodeURIComponent(id)}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: !ok,
        };
      }

      if (name === 'neo_list_projects') {
        const includeArchived = args?.includeArchived === true;
        const query = includeArchived ? '/projects?includeArchived=true' : '/projects';
        const { ok, data } = await fetchJsonFromBridge(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: !ok,
        };
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
      console.error('[MCPServer] Already running');
      return;
    }

    console.error('[MCPServer] Starting Agent Neo MCP Server...');

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.isRunning = true;
    console.error('[MCPServer] Agent Neo MCP Server started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.error('[MCPServer] Stopping Agent Neo MCP Server...');
    await this.server.close();
    this.isRunning = false;
    console.error('[MCPServer] Agent Neo MCP Server stopped');
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
