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

// ⚠️ webEnvInit 必须是第一个 import — 设置 CODE_AGENT_CLI_MODE 防止 keytar SIGSEGV
import './webEnvInit';

// electron mock 通过 esbuild --alias:electron=./src/web/electronMock.ts 注入
import { handlers, ipcMain as mockIpcMain, BrowserWindow } from './electronMock';

import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupAllIpcHandlers, type IpcDependencies } from '../main/ipc';
import { createLogger } from '../main/services/infra/logger';

const logger = createLogger('WebServer');

// ============================================================================
// SSE 客户端管理
// ============================================================================

const sseClients = new Set<Response>();

// 活跃 AgentLoop 实例追踪（用于 cancel）
const activeAgentLoops = new Map<string, { cancel(): void }>();

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
 * 直接使用 main 服务（与 IPC handler 内部 import 一致）
 */
async function initializeServices(): Promise<void> {
  // 设置环境
  process.env.CODE_AGENT_CLI_MODE = 'true';
  process.env.CODE_AGENT_WEB_MODE = 'true';

  // 加载 .env 文件（确保 API Key 等环境变量可用）
  try {
    const dotenv = await import("dotenv");
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      logger.info(`.env loaded from ${envPath}`);
    }
  } catch (e) {
    logger.warn(".env loading failed:", (e as Error).message);
  }

  // 设置数据目录（electronMock 的 app.getPath('userData') 也读这个变量）
  const dataDir = path.join(os.homedir(), '.code-agent');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  process.env.CODE_AGENT_DATA_DIR = dataDir;

  // 1. 初始化 ConfigService（main 模块的单例，IPC handler 通过 getConfigService() 获取）
  const { initConfigService } = await import('../main/services/core/configService');
  const configService = initConfigService();
  await configService.initialize();
  logger.info('ConfigService initialized');

  // 2. 初始化 Supabase（auth 等服务依赖）
  try {
    const { initSupabase } = await import('../main/services/infra/supabaseService');
    const { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } = await import('../shared/constants');
    const settings = configService.getSettings() as Record<string, any>;
    const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;
    initSupabase(supabaseUrl, supabaseAnonKey);
    logger.info('Supabase initialized');
  } catch (error) {
    logger.warn('Supabase not available:', (error as Error).message);
  }

  // 3. 初始化 AuthService（依赖 Supabase，恢复登录态）
  try {
    const { getAuthService } = await import('../main/services/auth/authService');
    await getAuthService().initialize();
    logger.info('AuthService initialized');
  } catch (error) {
    logger.warn('AuthService not available:', (error as Error).message);
  }

  // 4. 初始化 Database（main 模块的单例，SessionManager 等依赖）
  try {
    const { initDatabase } = await import('../main/services/core/databaseService');
    await initDatabase();
    logger.info('Database initialized');
  } catch (error) {
    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    logger.warn('Database not available:', msg);
  }

  // 5. 初始化 MemoryService（session handler 的 handleCreate 会调用 getMemoryService）
  try {
    const { initMemoryService } = await import('../main/memory/memoryService');
    initMemoryService({
      maxRecentMessages: 10,
      toolCacheTTL: 5 * 60 * 1000,
      maxSessionMessages: 100,
      maxRAGResults: 5,
      ragTokenLimit: 2000,
    });
    logger.info('MemoryService initialized');
  } catch (error) {
    logger.warn('MemoryService not available:', (error as Error).message);
  }

  logger.info('Backend services initialized');
}

/**
 * 注册所有 IPC handler 到 mock ipcMain
 */
// Web 模式的全局 BrowserWindow 实例（webContents.send → broadcastSSE）
const webModeWindow = new BrowserWindow();

function registerHandlers(): void {
  let currentSessionId: string | null = null;

  const deps: IpcDependencies = {
    getMainWindow: () => webModeWindow as any,
    getOrchestrator: () => null, // Agent execution via /api/run
    getConfigService: () => {
      try {
        const { getConfigService } = require('../main/services/core/configService');
        return getConfigService();
      } catch {
        return null;
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
  app.use(express.json({ limit: '50mb', strict: false }));

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
    // 使用请求中的 sessionId，或生成一个临时的（web 模式兼容）
    const sessionId = req.body.sessionId || `web-session-${Date.now()}`;
    sendSSE(res, 'task_start', { taskId, prompt, sessionId });

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

      // Fix: CLI config maps 'anthropic' but provider is 'claude'
      // Ensure apiKey is populated from env if missing
      if (!config.modelConfig.apiKey) {
        const providerEnvMap: Record<string, string> = {
          claude: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          deepseek: 'DEEPSEEK_API_KEY',
          gemini: 'GEMINI_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          groq: 'GROQ_API_KEY',
          moonshot: 'MOONSHOT_API_KEY',
        };
        const envKey = providerEnvMap[config.modelConfig.provider];
        if (envKey && process.env[envKey]) {
          config.modelConfig.apiKey = process.env[envKey];
        }
      }

      // Create initial messages array with user message
      // (AgentLoop expects the caller to add user message to messages before run())
      const userContent: unknown[] = [{ type: 'text', text: prompt }];
      // 附件支持：将 base64 图片转为 multipart content
      if (req.body.attachments?.length) {
        for (const att of req.body.attachments) {
          if (att.category === 'image' && att.data) {
            userContent.push({
              type: 'image',
              source: { type: 'base64', media_type: att.mimeType || 'image/png', data: att.data },
            });
          }
        }
      }

      const messages = [{
        id: `msg-${Date.now()}`,
        role: 'user' as const,
        content: userContent.length === 1 ? prompt : userContent,
        timestamp: Date.now(),
      }];

      const agentLoop = createAgentLoop(config, (event) => {
        // 所有事件都附带 sessionId，确保前端会话隔离正常工作
        const eventData = event.data ? { ...event.data, sessionId } : { sessionId };
        sendSSE(res, event.type, eventData);
      }, messages);

      // 存储当前 agentLoop 引用，供 cancel 使用
      activeAgentLoops.set(sessionId, agentLoop);

      await agentLoop.run(prompt);

      // 发送 agent_complete（useAgent 依赖此事件清除处理状态）
      sendSSE(res, 'agent_complete', { sessionId });
    } catch (error) {
      sendSSE(res, 'error', {
        message: error instanceof Error ? error.message : 'Unknown error',
        sessionId,
      });
    } finally {
      activeAgentLoops.delete(sessionId);
      res.end();
    }
  });

  // ── Cancel ─────────────────────────────────────────────────────────
  app.post('/api/cancel', (req: Request, res: Response) => {
    const sessionId = req.body?.sessionId;
    if (sessionId && activeAgentLoops.has(sessionId)) {
      activeAgentLoops.get(sessionId)!.cancel();
      activeAgentLoops.delete(sessionId);
      res.json({ message: 'Cancelled', sessionId });
    } else if (activeAgentLoops.size > 0) {
      // 没指定 sessionId 时取消最后一个
      const lastKey = [...activeAgentLoops.keys()].pop()!;
      activeAgentLoops.get(lastKey)!.cancel();
      activeAgentLoops.delete(lastKey);
      res.json({ message: 'Cancelled', sessionId: lastKey });
    } else {
      res.json({ message: 'No active agent to cancel' });
    }
  });

  // ── Sessions ───────────────────────────────────────────────────────
  app.get('/api/sessions', async (_req: Request, res: Response) => {
    try {
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:session');
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
      const handler = handlers.get('domain:settings');
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
      const handler = handlers.get('domain:settings');
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
    // 有些用 IPC_DOMAINS.XXX (如 'domain:session', 'domain:agent')
    // 有些用 IPC_CHANNELS.XXX (如 'session:list', 'settings:get')
    const handler = handlers.get(domain) || handlers.get(`domain:${domain}`);

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
  app.all('/api/:channel/{*rest}', async (req: Request, res: Response) => {
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

  // ── Static file serving (production) ─────────────────────────────
  const staticDir = path.join(process.cwd(), 'dist', 'renderer');
  app.use(express.static(staticDir));
  // SPA fallback — serve index.html for non-API routes
  app.get('/{*path}', (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, 'index.html'));
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

  // ── Static files (production) ─────────────────────────────────────
  const staticDir = path.join(process.cwd(), 'dist/renderer');
  app.use(express.static(staticDir));
  app.get('/{*path}', (_req: any, res: any) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

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
