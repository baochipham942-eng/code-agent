// ============================================================================
// Web Server - 独立 HTTP API 服务器（无 Electron 依赖）
// ============================================================================
//
// 使 renderer 可以在浏览器中运行，无需 Electron。
// 通过 mock ipcMain 来复用所有现有 IPC handler 逻辑。
//
// 启动方式:
//   node dist/web/webServer.cjs
//   或 dev 模式: npm run dev:web
//
// ============================================================================

// ⚠️ 必须在任何其他 import 之前安装 electron mock
import { installElectronMock, handlers, mockIpcMain } from './electronMock';
installElectronMock();

import http from 'http';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupAllIpcHandlers, type IpcDependencies } from '../main/ipc';
import { createLogger } from '../main/services/infra/logger';

const logger = createLogger('WebServer');

// ============================================================================
// SSE 客户端管理
// ============================================================================

const sseClients = new Set<Response>();

/**
 * 向所有 SSE 客户端推送事件
 */
export function broadcastSSE(channel: string, args: unknown): void {
  const data = JSON.stringify({ channel, args });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ============================================================================
// 服务初始化
// ============================================================================

/**
 * 初始化后端服务（数据库、配置等）
 * 复用 CLI 的初始化逻辑
 */
async function initializeServices(): Promise<void> {
  // 设置环境
  process.env.CODE_AGENT_CLI_MODE = 'true';
  process.env.CODE_AGENT_WEB_MODE = 'true';

  // 使用 CLI 的 bootstrap 来初始化核心服务
  const { initializeCLIServices } = await import('../cli/bootstrap');
  await initializeCLIServices();

  logger.info('Backend services initialized');
}

/**
 * 注册所有 IPC handler 到 mock ipcMain
 */
function registerHandlers(): void {
  let currentSessionId: string | null = null;

  const deps: IpcDependencies = {
    getMainWindow: () => null,
    getOrchestrator: () => null, // Agent execution via /api/run
    getConfigService: () => {
      try {
        // 尝试获取 main 的 ConfigService
        const { getConfigService } = require('../main/services/core/configService');
        return getConfigService();
      } catch {
        // 降级到 CLI 的 ConfigService
        try {
          const { getConfigService } = require('../cli/bootstrap');
          return getConfigService();
        } catch {
          return null;
        }
      }
    },
    getPlanningService: () => null,
    getTaskManager: () => null,
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (id: string) => {
      currentSessionId = id;
    },
  };

  // setupAllIpcHandlers 会同时处理:
  // 1. 接受 ipcMain 参数的 handler — 注册到我们传入的 mockIpcMain
  // 2. 直接 import { ipcMain } from 'electron' 的 handler — 注册到 electronMock 的 ipcMain
  // 由于 installElectronMock() 已将 'electron' 模块替换为 mock，两种方式最终都注册到同一个 handlers Map
  setupAllIpcHandlers(mockIpcMain as any, deps);

  logger.info(`Registered ${handlers.size} IPC handlers`);
}

// ============================================================================
// Express 应用
// ============================================================================

function createApp(): express.Express {
  const app = express();

  // CORS
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // JSON body parser
  app.use(express.json({ limit: '50mb' }));

  // ── Health ──────────────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: Date.now(),
      handlers: handlers.size,
    });
  });

  // ── SSE Events ─────────────────────────────────────────────────────
  app.get('/api/events', (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"channel":"connected","args":{}}\n\n');

    sseClients.add(res);

    _req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // ── Agent Run (SSE streaming) ──────────────────────────────────────
  app.post('/api/run', async (req: Request, res: Response) => {
    const { prompt, project, model, provider, generation } = req.body;

    if (!prompt) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const taskId = `task-${Date.now()}`;
    sendSSE(res, 'task_start', { taskId, prompt });

    try {
      const { createCLIAgent } = await import('../cli/adapter');
      const { createAgentLoop } = await import('../cli/bootstrap');

      const agent = await createCLIAgent({
        project: project || process.cwd(),
        gen: generation,
        model,
        provider,
        json: true,
      });

      const config = agent.getConfig();
      const agentLoop = createAgentLoop(config, (event) => {
        sendSSE(res, event.type, event.data);
      });

      await agentLoop.run(prompt);

      sendSSE(res, 'task_complete', { taskId });
    } catch (error) {
      sendSSE(res, 'error', {
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      res.end();
    }
  });

  // ── Cancel ─────────────────────────────────────────────────────────
  app.post('/api/cancel', (_req: Request, res: Response) => {
    // TODO: Implement cancel via orchestrator
    res.json({ message: 'Cancel requested' });
  });

  // ── Sessions ───────────────────────────────────────────────────────
  app.get('/api/sessions', async (_req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, {
          action: 'list',
          payload: { includeArchived: _req.query.includeArchived === 'true' },
        });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.post('/api/sessions', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, { action: 'create', payload: req.body });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.get('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, { action: 'load', payload: { sessionId: req.params.id } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.get('/api/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, {
          action: 'getMessages',
          payload: {
            sessionId: req.params.id,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            before: req.query.before as string | undefined,
          },
        });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, { action: 'delete', payload: { sessionId: req.params.id } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.post('/api/sessions/:id/archive', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, { action: 'archive', payload: { sessionId: req.params.id } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.post('/api/sessions/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('session');
      if (handler) {
        const result = await handler(null, { action: 'unarchive', payload: { sessionId: req.params.id } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Session handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  // ── Settings ───────────────────────────────────────────────────────
  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      const handler = handlers.get('settings');
      if (handler) {
        const result = await handler(null, { action: 'get', payload: undefined });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Settings handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('settings');
      if (handler) {
        const result = await handler(null, { action: 'set', payload: { settings: req.body } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Settings handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  // ── Domain Router (universal) ──────────────────────────────────────
  // Matches what httpTransport.ts's createHttpDomainAPI() calls:
  //   POST /api/domain/:domain/:action
  app.post('/api/domain/:domain/:action', async (req: Request, res: Response) => {
    const domain = String(req.params.domain);
    const action = String(req.params.action);
    const { payload, requestId } = req.body;

    // 查找 handler — IPC handler 注册时使用的 channel 名
    // 有些用 IPC_DOMAINS.XXX (如 'session', 'agent')
    // 有些用 IPC_CHANNELS.XXX (如 'session:list', 'settings:get')
    const handler = handlers.get(domain);

    if (handler) {
      try {
        const result = await handler(null, { action, payload, requestId });
        res.json(result);
      } catch (error) {
        logger.error(`Domain handler error: ${domain}:${action}`, error);
        res.status(500).json({
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: formatError(error),
          },
        });
      }
      return;
    }

    // 尝试 "domain:action" 格式的直接通道匹配
    const directChannel = `${domain}:${action}`;
    const directHandler = handlers.get(directChannel);

    if (directHandler) {
      try {
        const result = await directHandler(null, payload);
        res.json(result);
      } catch (error) {
        logger.error(`Direct handler error: ${directChannel}`, error);
        res.status(500).json({
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: formatError(error),
          },
        });
      }
      return;
    }

    logger.warn(`No handler for domain: ${domain}, action: ${action}`);
    logger.warn(`Available handlers: ${[...handlers.keys()].join(', ')}`);
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `No handler for domain:${domain} action:${action}`,
      },
    });
  });

  // ── Fallback for unmapped IPC channels ─────────────────────────────
  // httpTransport.ts's channelToEndpoint() maps some channels to
  // generic paths like /api/memory/search-code
  app.all('/api/:channel/*', async (req: Request, res: Response) => {
    // Reconstruct channel name: /api/memory/search-code -> memory:search-code
    const pathParts = req.path.replace('/api/', '').split('/');
    const channel = pathParts.join(':');

    const handler = handlers.get(channel);
    if (handler) {
      try {
        const result = await handler(null, req.method === 'GET' ? req.query : req.body);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: formatError(error) });
      }
      return;
    }

    res.status(404).json({ error: `Unknown channel: ${channel}` });
  });

  return app;
}

// ============================================================================
// Helpers
// ============================================================================

function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const port = parseInt(process.env.WEB_PORT || '8080', 10);
  const host = process.env.WEB_HOST || '127.0.0.1';

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Code Agent — Web Standalone Mode       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // 1. 初始化后端服务
  console.log('[1/3] Initializing backend services...');
  await initializeServices();

  // 2. 注册 IPC handler
  console.log('[2/3] Registering IPC handlers...');
  registerHandlers();

  // 3. 启动 HTTP 服务
  console.log('[3/3] Starting HTTP server...');
  const app = createApp();

  const server = http.createServer(app);

  server.listen(port, host, () => {
    console.log();
    console.log(`  API server:  http://${host}:${port}`);
    console.log(`  Health:      http://${host}:${port}/api/health`);
    console.log(`  SSE Events:  http://${host}:${port}/api/events`);
    console.log();
    console.log(`  Registered handlers: ${handlers.size}`);
    console.log(`  Channels: ${[...handlers.keys()].slice(0, 10).join(', ')}...`);
    console.log();
    console.log('  Start Vite dev server separately:');
    console.log('    npm run dev:renderer');
    console.log();
  });

  // 优雅退出
  const shutdown = () => {
    console.log('\nShutting down...');
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start web server:', err);
  process.exit(1);
});
