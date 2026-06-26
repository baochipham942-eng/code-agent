// ============================================================================
// Log Bridge - HTTP server for sharing logs between Electron app and MCP server
// Also supports command execution for remote control
// ============================================================================

import http from 'http';
import { logCollector, LogSource } from './logCollector.js';
import { PORTS } from '../../shared/constants/index.js';

// Command handler type
export type CommandHandler = (command: string, params: Record<string, unknown>) => Promise<{
  success: boolean;
  output?: string;
  error?: string;
}>;

/**
 * 只读任务状态提供者（P3-A）。logBridge 不直接依赖 TaskStatusProvider 具体类，
 * 只依赖这个最小接口（同 CommandHandler 的解耦模式），上层在 app 进程内注入实现。
 * 全部 read-only：仅暴露元数据，不碰写/执行路径。
 */
export interface TaskStatusBridgeProvider {
  listTasks(opts: { limit?: number }): unknown;
  getTaskStatus(runId: string): unknown;
  listProjects(opts: { includeArchived?: boolean }): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExecuteCommandBody(body: string): { command: string; params: Record<string, unknown> } | null {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || typeof parsed.command !== 'string') return null;
  return {
    command: parsed.command,
    params: isRecord(parsed.params) ? parsed.params : {},
  };
}

class LogBridge {
  private server: http.Server | null = null;
  private port: number = PORTS.logBridge;
  private commandHandler: CommandHandler | null = null;
  private taskStatusProvider: TaskStatusBridgeProvider | null = null;

  /**
   * Start the HTTP log bridge server (called from Electron main process)
   */
  async start(port: number = PORTS.logBridge): Promise<void> {
    if (this.server) {
      console.error('[LogBridge] Already running');
      return;
    }

    this.port = port;

    this.server = http.createServer((req, res) => {
      // Enable CORS for local access
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const path = url.pathname;

      try {
        if (path === '/logs/browser') {
          const count = parseInt(url.searchParams.get('count') || '50');
          const logs = logCollector.getLogs('browser', count);
          res.writeHead(200);
          res.end(JSON.stringify(logs));
        } else if (path === '/logs/agent') {
          const count = parseInt(url.searchParams.get('count') || '50');
          const logs = logCollector.getLogs('agent', count);
          res.writeHead(200);
          res.end(JSON.stringify(logs));
        } else if (path === '/logs/tool') {
          const count = parseInt(url.searchParams.get('count') || '50');
          const logs = logCollector.getLogs('tool', count);
          res.writeHead(200);
          res.end(JSON.stringify(logs));
        } else if (path === '/logs/all') {
          const count = parseInt(url.searchParams.get('count') || '100');
          const logs = logCollector.getAllLogs(count);
          res.writeHead(200);
          res.end(JSON.stringify(logs));
        } else if (path === '/status') {
          const status = logCollector.getStatus();
          res.writeHead(200);
          res.end(JSON.stringify(status));
        } else if (path === '/tasks') {
          // P3-A 只读：列 swarm 运行历史 + 实时会话状态（仅元数据）。
          if (!this.taskStatusProvider) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'No task status provider registered' }));
          } else {
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
            res.writeHead(200);
            res.end(JSON.stringify(this.taskStatusProvider.listTasks({ limit })));
          }
        } else if (path === '/task-status') {
          // P3-A 只读：查指定 swarm run 详情（进度/token/事件计数，仅元数据）。
          if (!this.taskStatusProvider) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'No task status provider registered' }));
          } else {
            const id = url.searchParams.get('id');
            if (!id) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing id parameter' }));
            } else {
              const status = this.taskStatusProvider.getTaskStatus(id);
              res.writeHead(status ? 200 : 404);
              res.end(JSON.stringify(status ?? { error: `Run ${id} not found` }));
            }
          }
        } else if (path === '/projects') {
          // P3-A 只读：列项目 + goal 状态（仅元数据）。
          if (!this.taskStatusProvider) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'No task status provider registered' }));
          } else {
            const includeArchived = url.searchParams.get('includeArchived') === 'true';
            res.writeHead(200);
            res.end(JSON.stringify(this.taskStatusProvider.listProjects({ includeArchived })));
          }
        } else if (path === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', port: this.port }));
        } else if (path === '/clear') {
          const source = url.searchParams.get('source') as LogSource | 'all';
          if (source === 'all') {
            logCollector.clearAll();
          } else if (source) {
            logCollector.clear(source);
          }
          res.writeHead(200);
          res.end(JSON.stringify({ cleared: source || 'none' }));
        } else if (path === '/execute' && req.method === 'POST') {
          // Handle command execution
          this.handleExecuteCommand(req, res);
          return; // Don't end response here, handled in async method
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });

    const server = this.server;
    return new Promise((resolve, reject) => {
      server.listen(this.port, '127.0.0.1', () => {
        // 传入端口 0 时由 OS 分配空闲端口，回填实际端口供调用方读取（测试隔离用）。
        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;
        console.error(`[LogBridge] HTTP log server started on http://127.0.0.1:${this.port}`);
        resolve();
      });

      server.on('error', (err) => {
        console.error('[LogBridge] Failed to start:', err);
        reject(err);
      });
    });
  }

  /**
   * Stop the log bridge server
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          console.error('[LogBridge] Server stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Set the command handler for executing commands from MCP
   */
  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
    console.error('[LogBridge] Command handler registered');
  }

  /**
   * 注册只读任务状态提供者（P3-A）。在 app 进程内调用，提供 swarm/project/session 查询。
   */
  setTaskStatusProvider(provider: TaskStatusBridgeProvider): void {
    this.taskStatusProvider = provider;
    console.error('[LogBridge] Task status provider registered');
  }

  /**
   * Handle POST /execute requests
   */
  private async handleExecuteCommand(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Read request body
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const parsed = parseExecuteCommandBody(body);

        if (!parsed) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing command' }));
          return;
        }

        if (!this.commandHandler) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'No command handler registered' }));
          return;
        }

        logCollector.agent('INFO', `Received remote command: ${parsed.command}`);

        const result = await this.commandHandler(parsed.command, parsed.params);

        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  }
}

// Singleton
export const logBridge = new LogBridge();
