// ============================================================================
// Log Bridge - HTTP server for sharing logs between Electron app and MCP server
// Also supports command execution for remote control
// ============================================================================

import http from 'http';
import { logCollector, LogSource } from './LogCollector.js';

const DEFAULT_PORT = 51820; // Arbitrary port for log bridge

// Command handler type
export type CommandHandler = (command: string, params: Record<string, unknown>) => Promise<{
  success: boolean;
  output?: string;
  error?: string;
}>;

class LogBridge {
  private server: http.Server | null = null;
  private port: number = DEFAULT_PORT;
  private commandHandler: CommandHandler | null = null;

  /**
   * Start the HTTP log bridge server (called from Electron main process)
   */
  async start(port: number = DEFAULT_PORT): Promise<void> {
    if (this.server) {
      console.log('[LogBridge] Already running');
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

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        console.log(`[LogBridge] HTTP log server started on http://127.0.0.1:${this.port}`);
        resolve();
      });

      this.server!.on('error', (err) => {
        console.error('[LogBridge] Failed to start:', err);
        reject(err);
      });
    });
  }

  /**
   * Stop the log bridge server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log('[LogBridge] Server stopped');
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
    console.log('[LogBridge] Command handler registered');
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
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { command, params } = JSON.parse(body);

        if (!command) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing command' }));
          return;
        }

        if (!this.commandHandler) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'No command handler registered' }));
          return;
        }

        logCollector.agent('INFO', `Received remote command: ${command}`);

        const result = await this.commandHandler(command, params || {});

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
